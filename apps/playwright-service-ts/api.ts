import express, { Request, Response } from 'express'
import bodyParser from 'body-parser'
import { chromium, Browser, BrowserContext, Route, Request as PlaywrightRequest, Page } from 'playwright'
import dotenv from 'dotenv'
import UserAgent from 'user-agents'
import { getError } from './helpers/get_error'

dotenv.config()

const app = express()
const port = process.env.PORT || 3003

app.use(bodyParser.json())

const BLOCK_MEDIA = (process.env.BLOCK_MEDIA || 'False').toUpperCase() === 'TRUE'

const PROXY_SERVER = process.env.PROXY_SERVER || null
const PROXY_USERNAME = process.env.PROXY_USERNAME || null
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || null

const AD_SERVING_DOMAINS = [
  'doubleclick.net',
  'adservice.google.com',
  'googlesyndication.com',
  'googletagservices.com',
  'googletagmanager.com',
  'google-analytics.com',
  'adsystem.com',
  'adservice.com',
  'adnxs.com',
  'ads-twitter.com',
  'facebook.net',
  'fbcdn.net',
  'amazon-adsystem.com'
]

interface UrlModel {
  url: string
  wait_after_load?: number
  timeout?: number
  headers?: { [key: string]: string }
  check_selector?: string
}

let browser: Browser
let context: BrowserContext

// Health status tracking
let browserInitialized = false
let browserInitError: Error | null = null
let initializationInProgress = false

const initializeBrowser = async () => {
  // Skip if already initializing to prevent multiple concurrent initializations
  if (initializationInProgress) {
    console.log('Browser initialization already in progress, skipping...')
    return
  }

  initializationInProgress = true
  browserInitError = null

  try {
    console.log('Initializing browser...')
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu'
      ]
    })

    const userAgent = new UserAgent().toString()
    const viewport = { width: 1280, height: 800 }

    const contextOptions: any = {
      userAgent,
      viewport,
    }

    if (PROXY_SERVER && PROXY_USERNAME && PROXY_PASSWORD) {
      contextOptions.proxy = {
        server: PROXY_SERVER,
        username: PROXY_USERNAME,
        password: PROXY_PASSWORD,
      }
    } else if (PROXY_SERVER) {
      contextOptions.proxy = {
        server: PROXY_SERVER,
      }
    }

    context = await browser.newContext(contextOptions)

    if (BLOCK_MEDIA) {
      await context.route('**/*.{png,jpg,jpeg,gif,svg,mp3,mp4,avi,flac,ogg,wav,webm}', async (route: Route, request: PlaywrightRequest) => {
        await route.abort()
      })
    }

    // Intercept all requests to avoid loading ads
    await context.route('**/*', (route: Route, request: PlaywrightRequest) => {
      const requestUrl = new URL(request.url())
      const hostname = requestUrl.hostname

      if (AD_SERVING_DOMAINS.some(domain => hostname.includes(domain))) {
        console.log(hostname)
        return route.abort()
      }
      return route.continue()
    })

    browserInitialized = true
    console.log('Browser successfully initialized')
  } catch (error) {
    console.error('Failed to initialize browser:', error)
    browserInitError = error instanceof Error ? error : new Error(String(error))
    browserInitialized = false
  } finally {
    initializationInProgress = false
  }
}

const shutdownBrowser = async () => {
  if (context) {
    await context.close()
  }
  if (browser) {
    await browser.close()
  }
}

const isValidUrl = (urlString: string): boolean => {
  try {
    new URL(urlString)
    return true
  } catch (_) {
    return false
  }
}

const scrapePage = async (page: Page, url: string, waitUntil: 'load' | 'networkidle', waitAfterLoad: number, timeout: number, checkSelector: string | undefined) => {
  console.log(`Navigating to ${url} with waitUntil: ${waitUntil} and timeout: ${timeout}ms`)
  const response = await page.goto(url, { waitUntil, timeout })

  if (waitAfterLoad > 0) {
    await page.waitForTimeout(waitAfterLoad)
  }

  if (checkSelector) {
    try {
      await page.waitForSelector(checkSelector, { timeout })
    } catch (error) {
      throw new Error('Required selector not found')
    }
  }

  let headers = null, content = await page.content()
  if (response) {
    headers = await response.allHeaders()
    const ct = Object.entries(headers).find(x => x[0].toLowerCase() === "content-type")
    if (ct && (ct[1].includes("application/json") || ct[1].includes("text/plain"))) {
      content = (await response.body()).toString("utf8") // TODO: determine real encoding
    }
  }

  return {
    content,
    status: response ? response.status() : null,
    headers,
  }
}

// Add health check endpoints for Kubernetes
app.get('/health/liveness', (req: Request, res: Response) => {
  // For liveness, we just need to know the service is running
  res.status(200).json({ status: 'alive' })
})

app.get('/health/readiness', async (req: Request, res: Response) => {
  // For readiness, we need to check if the browser is initialized
  if (browserInitialized) {
    return res.status(200).json({ status: 'ready' })
  }

  // If there was an error initializing the browser, return an error
  if (browserInitError) {
    console.error('Browser initialization error:', browserInitError)
    return res.status(503).json({
      status: 'not ready',
      error: browserInitError.message
    })
  }

  // If browser initialization is in progress, report as not ready
  if (initializationInProgress) {
    return res.status(503).json({
      status: 'not ready',
      message: 'Browser initialization in progress'
    })
  }

  // If browser is not initialized and not currently initializing, try to initialize it
  if (!initializationInProgress && !browserInitialized) {
    try {
      // Don't await this - we don't want to block the response
      initializeBrowser()
      return res.status(503).json({
        status: 'not ready',
        message: 'Browser initialization started'
      })
    } catch (error) {
      return res.status(503).json({
        status: 'not ready',
        error: 'Failed to start browser initialization'
      })
    }
  }

  return res.status(503).json({
    status: 'not ready',
    message: 'Unknown state'
  })
})

app.post('/scrape', async (req: Request, res: Response) => {
  const { url, wait_after_load = 0, timeout = 15000, headers, check_selector }: UrlModel = req.body

  console.log(`================= Scrape Request =================`)
  console.log(`URL: ${url}`)
  console.log(`Wait After Load: ${wait_after_load}`)
  console.log(`Timeout: ${timeout}`)
  console.log(`Headers: ${headers ? JSON.stringify(headers) : 'None'}`)
  console.log(`Check Selector: ${check_selector ? check_selector : 'None'}`)
  console.log(`==================================================`)

  if (!url) {
    return res.status(400).json({ error: 'URL is required' })
  }

  if (!isValidUrl(url)) {
    return res.status(400).json({ error: 'Invalid URL' })
  }

  if (!PROXY_SERVER) {
    console.warn('⚠️ WARNING: No proxy server provided. Your IP address may be blocked.')
  }

  if (!browser || !context || !browserInitialized) {
    try {
      await initializeBrowser()
      // If initialization still fails, report the error
      if (!browserInitialized) {
        return res.status(500).json({
          error: 'Browser initialization failed',
          details: browserInitError?.message || 'Unknown error'
        })
      }
    } catch (error) {
      return res.status(500).json({
        error: 'Browser initialization failed',
        details: error instanceof Error ? error.message : String(error)
      })
    }
  }

  const page = await context.newPage()

  // Set headers if provided
  if (headers) {
    await page.setExtraHTTPHeaders(headers)
  }

  let result: Awaited<ReturnType<typeof scrapePage>>
  try {
    // Strategy 1: Normal
    console.log('Attempting strategy 1: Normal load')
    result = await scrapePage(page, url, 'load', wait_after_load, timeout, check_selector)
  } catch (error) {
    console.log('Strategy 1 failed, attempting strategy 2: Wait until networkidle')
    try {
      // Strategy 2: Wait until networkidle
      result = await scrapePage(page, url, 'networkidle', wait_after_load, timeout, check_selector)
    } catch (finalError) {
      await page.close()
      return res.status(500).json({ error: 'An error occurred while fetching the page.' })
    }
  }

  const pageError = result.status !== 200 ? getError(result.status) : undefined

  if (!pageError) {
    console.log(`✅ Scrape successful!`)
  } else {
    console.log(`🚨 Scrape failed with status code: ${result.status} ${pageError}`)
  }

  await page.close()

  res.json({
    content: result.content,
    pageStatusCode: result.status,
    ...(pageError && { pageError })
  })
})

app.listen(port, () => {
  initializeBrowser().then(() => {
    console.log(`Server is running on port ${port}`)
  })
})

process.on('SIGINT', () => {
  shutdownBrowser().then(() => {
    console.log('Browser closed')
    process.exit(0)
  })
})
