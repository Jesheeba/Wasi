const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  console.log('Starting Playwright scraper for app.kwic.in...');

  const outputDir = path.join(__dirname, 'scraped_pages');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 }
  });
  const page = await context.newPage();

  try {
    // 1. Go to Login Page
    console.log('Navigating to https://app.kwic.in/login...');
    await page.goto('https://app.kwic.in/login', { waitUntil: 'networkidle' });

    // 2. Perform Login
    console.log('Filling login credentials...');
    await page.fill('input[name="username"]', process.env.KWIC_USERNAME);
    await page.fill('input[name="password"]', process.env.KWIC_PASSWORD);
    await page.click('button[type="submit"]');

    console.log('Waiting for login redirect...');
    await page.waitForTimeout(5000);
    console.log('Current URL after login:', page.url());

    // Take screenshot of home/chat view after login
    await page.screenshot({ path: path.join(outputDir, '01_login_home.png') });
    fs.writeFileSync(path.join(outputDir, '01_login_home.html'), await page.content());

    // List of all sub-routes to visit step-by-step
    const routes = [
      { name: 'chat', url: 'https://app.kwic.in/app/chat' },
      { name: 'contacts', url: 'https://app.kwic.in/app/contacts' },
      { name: 'campaigns', url: 'https://app.kwic.in/app/campaigns' },
      { name: 'templates', url: 'https://app.kwic.in/app/template' },
      { name: 'automation', url: 'https://app.kwic.in/app/automation' },
      { name: 'ecommerce', url: 'https://app.kwic.in/app/ecommerce' },
      { name: 'flows', url: 'https://app.kwic.in/app/flows' },
      { name: 'instagram', url: 'https://app.kwic.in/app/instagram' },
      { name: 'ctwa', url: 'https://app.kwic.in/app/ctwa' },
      { name: 'integrations', url: 'https://app.kwic.in/app/integrations' },
      { name: 'payments', url: 'https://app.kwic.in/app/payments' },
      { name: 'analytics', url: 'https://app.kwic.in/app/analytics' },
      
      // Reports sub-pages
      { name: 'reports_message', url: 'https://app.kwic.in/app/reports/message' },
      { name: 'reports_tags', url: 'https://app.kwic.in/app/reports/tags' },
      { name: 'reports_campaign', url: 'https://app.kwic.in/app/reports/campaign' },
      { name: 'reports_flow', url: 'https://app.kwic.in/app/reports/flow' },
      { name: 'reports_api', url: 'https://app.kwic.in/app/reports/api' },
      { name: 'reports_livechat', url: 'https://app.kwic.in/app/reports/live-chat' },
      { name: 'reports_operator', url: 'https://app.kwic.in/app/reports/operator-stats' },

      // Settings sub-pages
      { name: 'settings_whatsapp', url: 'https://app.kwic.in/app/settings/whatsapp' },
      { name: 'settings_livechat', url: 'https://app.kwic.in/app/settings/live-chat' },
      { name: 'settings_team', url: 'https://app.kwic.in/app/settings/team' },
      { name: 'settings_wallet', url: 'https://app.kwic.in/app/settings/wallet' },
      { name: 'settings_subscription', url: 'https://app.kwic.in/app/settings/subscription' },
      { name: 'settings_developer', url: 'https://app.kwic.in/app/settings/developer' },
      { name: 'settings_tags', url: 'https://app.kwic.in/app/settings/tags' },
      { name: 'settings_attributes', url: 'https://app.kwic.in/app/settings/attributes' },
      { name: 'settings_webhook', url: 'https://app.kwic.in/app/settings/webhook' },
      { name: 'settings_billing', url: 'https://app.kwic.in/app/settings/billing' }
    ];

    for (let i = 0; i < routes.length; i++) {
      const r = routes[i];
      console.log(`[${i+1}/${routes.length}] Visiting ${r.url}...`);
      try {
        await page.goto(r.url, { waitUntil: 'networkidle', timeout: 15000 });
        await page.waitForTimeout(2000);
        
        const htmlPath = path.join(outputDir, `${r.name}.html`);
        const imgPath = path.join(outputDir, `${r.name}.png`);

        await page.screenshot({ path: imgPath, fullPage: true });
        fs.writeFileSync(htmlPath, await page.content());
        console.log(`Saved HTML & Screenshot for ${r.name}`);
      } catch (err) {
        console.error(`Error loading ${r.url}:`, err.message);
      }
    }

    console.log('Playwright scraping completed successfully!');
  } catch (error) {
    console.error('Fatal Scraper Error:', error);
  } finally {
    await browser.close();
  }
})();
