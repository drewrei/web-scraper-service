const express = require('express');
const rateLimit = require('express-rate-limit');
const Joi = require('joi');
const validator = require('validator');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const fetch = require('node-fetch');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.set('trust proxy', 1);
const port = process.env.PORT || 8080;

const WHITELISTED_DOMAINS = [
  'freshbooks.com', 'quickbooks.intuit.com', 'xero.com', 'zoho.com',
  'sendgrid.net', 'invoicesimple.com', 'pdf2.invoicesimple.com',
  'getjobber.com', 'skynova.com', 'invoicefly.com', 'awstrack.me',
  'waveapps.com', 'next.waveapps.com', 'track.pstmrk.it',
  'invoiceasap.com', 'email.invoiceasap.com', 'view.invoiceasap.com',
  'joistapp.com', 'docrenderer.prd.joistapp.com'
];

console.log('=== STARTUP ===', { port });

const scraperLimiter = rateLimit({ windowMs: 15*60*1000, max: 10 });
app.use('/scrape-pdf', scraperLimiter);
app.get('/', (req, res) => res.send('Web Scraper Service v11'));

const requestSchema = Joi.object({ url: Joi.string().uri().required() });

app.post('/scrape-pdf', async (req, res) => {
  const { error } = requestSchema.validate(req.body);
  if (error) return res.status(400).json({ success: false, error: error.details[0].message });

  let targetUrl = (req.body.url || '').trim();
  if (!targetUrl) return res.status(400).json({ success: false, error: 'Empty URL' });

  // === BYPASS TRACKERS WITH FETCH ===
  try {
    const urlObj = new URL(targetUrl);
    const hostname = urlObj.hostname.toLowerCase();

    if (hostname.includes('track.pstmrk.it') || hostname.includes('awstrack.me') || hostname.includes('email.invoiceasap.com')) {
      console.log('Bypassing tracker with fetch:', targetUrl);
      const response = await fetch(targetUrl, { redirect: 'follow', timeout: 15000 });
      if (response.ok) {
        const finalUrl = response.url;
        if (finalUrl !== targetUrl) {
          targetUrl = finalUrl;
          console.log('Tracker bypassed →', targetUrl);
        }
      }
    }
  } catch (e) {
    console.warn('Tracker bypass failed, using Puppeteer anyway:', e.message);
  }

  let domain;
  try { domain = new URL(targetUrl).hostname.toLowerCase(); }
  catch { return res.status(400).json({ success: false, error: 'Bad URL' }); }

  if (!WHITELISTED_DOMAINS.some(d => domain.includes(d)))
    return res.status(400).json({ success: false, error: 'Domain not allowed' });

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: '/usr/bin/google-chrome',
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-gpu']
    });

    let pdf;
    if (domain.includes('joistapp.com') || domain.includes('docrenderer.prd.joistapp.com'))
      pdf = await printJoist(browser, targetUrl);
    else if (domain.includes('invoicefly.com'))
      pdf = await printInvoiceFly(browser, targetUrl);
    else
      pdf = await printPage(browser, targetUrl, 'Generic');

    res.json({ success: true, pdfBase64: pdf });
  } catch (e) {
    console.error('Scrape error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  } finally {
    if (browser) await browser.close().catch(()=>{});
  }
});

async function printPage(b, u, n) {
  const p = await b.newPage();
  await p.setViewport({ width: 1920, height: 1080 });
  await p.goto(u, { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r=>setTimeout(r,5000));
  const pdf = await p.pdf({ printBackground:true, format:'A4' });
  await p.close();
  return pdf.toString('base64');
}

async function printInvoiceFly(b, u) {
  const p = await b.newPage();
  await p.setViewport({ width:2560, height:1600 });
  await p.goto(u, { waitUntil:'networkidle0', timeout:90000 });
  let h=0,c=0;
  for(let i=0;i<60;i++){
    const ch = await p.evaluate(()=>document.body.scrollHeight);
    if(ch===h) c++; else c=0;
    if(c>=3 && ch>800) break;
    h=ch; await new Promise(r=>setTimeout(r,1000));
  }
  await new Promise(r=>setTimeout(r,5000));
  const pdf = await p.pdf({printBackground:true, format:'A4', width:'2560px', margin:0});
  await p.close();
  return pdf.toString('base64');
}

async function printJoist(browser, url) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1200 });
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

  await page.waitForSelector('iframe', { timeout: 20000 });
  const iframe = await (await page.$('iframe')).contentFrame();
  await iframe.waitForSelector('canvas', { timeout: 20000 });

  await page.evaluate(() => {
    document.querySelectorAll('aside, .sidebar, [class*="sidebar"], [class*="nav"]').forEach(el => el.style.display = 'none');
    document.body.style.marginLeft = '0';
  });

  const pdf = await page.pdf({
    printBackground: true,
    format: 'A4',
    margin: { top: '0.3in', bottom: '0.3in', left: '0.3in', right: '0.3in' }
  });

  await page.close();
  return pdf.toString('base64');
}

// THIS LINE WAS MISSING — ADD IT
app.listen(port, () => console.log(`=== LISTENING ON PORT ${port} ===`));
