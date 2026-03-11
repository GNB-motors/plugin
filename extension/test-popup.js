const puppeteer = require('puppeteer');

(async () => {
    try {
        const browser = await puppeteer.launch();
        const page = await browser.newPage();
        
        page.on('console', msg => console.log('BROWSER CONSOLE:', msg.text()));
        page.on('pageerror', error => console.error('BROWSER ERROR:', error.message));
        
        await page.goto('http://localhost:5173', { waitUntil: 'networkidle0', timeout: 5000 });
        
        await browser.close();
    } catch (e) {
        console.error('SCRIPT ERROR:', e.message);
    }
})();
