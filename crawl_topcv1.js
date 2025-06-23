const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const RecaptchaPlugin = require('puppeteer-extra-plugin-recaptcha');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

// --- Cấu hình ---
const BASE_URL = 'https://www.topcv.vn/tim-viec-lam-cong-nghe-thong-tin-cr257';
const QUERY_PARAMS = '?sba=1&category_family=r257';
const OUTPUT_FILE = path.join(__dirname, 'topcv_it_jobs.json');
const MAX_PAGES_TO_CRAWL = 70;
const MAX_CONCURRENT_REQUESTS = 3;
let browser;
let allJobDetails = [];

// Sử dụng plugin
puppeteer.use(StealthPlugin());
puppeteer.use(
    RecaptchaPlugin({
        provider: { id: '2captcha', token: 'YOUR_2CAPTCHA_API_KEY' } // Thay bằng API key thực
    })
);

async function crawlTopCV() {
    try {
        browser = await puppeteer.launch({
            headless: false, // Giữ false để debug
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-notifications',
                '--disable-dev-shm-usage',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process'
            ]
        });
        const page = await browser.newPage();
        await page.setViewport({ width: 1366, height: 768 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        let currentPage = 39; // Bắt đầu từ trang 1

        console.log(`Bắt đầu crawl từ ${BASE_URL}${QUERY_PARAMS}`);

        while (currentPage <= MAX_PAGES_TO_CRAWL) {
            const url = `${BASE_URL}${QUERY_PARAMS}&page=${currentPage}`;
            console.log(`\nĐang crawl trang: ${url}`);

            try {
                // Thử tải trang với retry
                let pageLoaded = false;
                for (let attempt = 1; attempt <= 3; attempt++) {
                    try {
                        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
                        pageLoaded = true;
                        break;
                    } catch (e) {
                        console.warn(`Lỗi tải trang ${url} (lần thử ${attempt}): ${e.message}`);
                        await new Promise(r => setTimeout(r, 5000));
                    }
                }
                if (!pageLoaded) {
                    console.error(`Không thể tải trang ${url} sau 3 lần thử. Bỏ qua.`);
                    break;
                }

                // Chờ JavaScript render
                try {
                    await page.waitForSelector('.job-item-search-result', { timeout: 15000 });
                } catch (e) {
                    console.warn(`⚠️ Không tìm thấy job-item-search-result trên trang ${currentPage}.`);
                    // Lưu HTML để debug
                    const htmlContent = await page.content();
                    fs.writeFileSync(`error_page_${currentPage}.html`, htmlContent, 'utf-8');
                    console.log(`Đã lưu HTML của trang lỗi vào error_page_${currentPage}.html`);
                }

                // Giả lập hành vi người dùng
                await page.evaluate(() => {
                    window.scrollBy(0, Math.random() * 1000 + 500);
                });
                await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));

                const htmlContent = await page.content();
                const $ = cheerio.load(htmlContent);

                const jobCards = $('.job-item-search-result');

                if (jobCards.length === 0) {
                    console.log(`Không tìm thấy tin tuyển dụng nào trên trang ${currentPage}.`);
                    break;
                }

                console.log(`Tìm thấy ${jobCards.length} tin tuyển dụng trên trang ${currentPage}`);

                const jobPromises = [];
                for (let i = 0; i < jobCards.length; i++) {
                    const card = jobCards.eq(i);
                    const jobTitle = card.find('.title').text().trim();
                    const companyName = card.find('.company-name').text().trim();
                    const salary = card.find('.title-salary').text().trim();
                    const location = card.find('.city-text').text().trim();
                    const jobLink = card.find('.title a').attr('href');
                    const category = card.find('.tag a').text().trim();

                    if (!jobLink) {
                        console.warn(`Không tìm thấy link cho công việc: "${jobTitle}". Bỏ qua.`);
                        continue;
                    }

                    const fullJobLink = jobLink.startsWith('http') ? jobLink : `https://www.topcv.vn${jobLink}`;
                    console.log(`  - Đang lấy chi tiết cho: "${jobTitle}" (${fullJobLink})`);

                    jobPromises.push(
                        getJobDetails(browser, fullJobLink).then(details => {
                            if (!details) return null;
                            return {
                                title: jobTitle,
                                company: companyName,
                                salary,
                                location,
                                link: fullJobLink,
                                category,
                                requiredSkills: details.requiredSkills,
                                description: details.description
                            };
                        })
                    );

                    if (jobPromises.length >= MAX_CONCURRENT_REQUESTS || i === jobCards.length - 1) {
                        const jobDetails = await Promise.all(jobPromises);
                        allJobDetails = allJobDetails.concat(jobDetails.filter(detail => detail !== null));
                        jobPromises.length = 0;
                        await new Promise(r => setTimeout(r, 4000 + Math.random() * 3000));
                        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(allJobDetails, null, 2), 'utf-8');
                        console.log(`✅ Đã lưu tạm thời ${allJobDetails.length} công việc sau trang ${currentPage}`);
                    }
                }
            } catch (pageError) {
                console.error(`Lỗi khi crawl trang ${currentPage}:`, pageError.message);
                break;
            }

            currentPage++;
        }

        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(allJobDetails, null, 2), 'utf-8');
        console.log(`\n============== Crawl Hoàn Tất ==============`);
        console.log(`Tổng số công việc đã crawl: ${allJobDetails.length}`);
        console.log(`Dữ liệu đã được lưu vào ${OUTPUT_FILE}`);

    } catch (error) {
        console.error('\nLỖI TỔNG QUAN TRONG QUÁ TRÌNH CRAWL:', error);
    } finally {
        if (browser) {
            await browser.close();
            console.log('Trình duyệt đã đóng.');
        }
    }
}

async function getJobDetails(browserInstance, jobUrl, retries = 3) {
    const page = await browserInstance.newPage();
    await page.setViewport({ width: 1366, height: 768 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            await page.goto(jobUrl, { waitUntil: 'networkidle2', timeout: 60000 });
            await page.evaluate(() => {
                window.scrollBy(0, Math.random() * 500 + 500);
                const x = Math.random() * window.innerWidth;
                const y = Math.random() * window.innerHeight;
                document.elementFromPoint(x, y).dispatchEvent(new MouseEvent('mousemove'));
            });
            await page.solveRecaptchas();
            await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));

            const pageTitle = await page.title();
            if (pageTitle.includes('Just a moment...') || pageTitle.includes('Verifying you are human')) {
                console.error(`Bị Cloudflare chặn trên trang chi tiết: ${jobUrl} (lần thử ${attempt})`);
                if (attempt === retries) return null;
                await new Promise(r => setTimeout(r, 5000));
                continue;
            }

            const htmlContent = await page.content();
            const $ = cheerio.load(htmlContent);

            const requiredSkills = [];
            $('div.box-category-tags span.box-category-tag').each((i, el) => {
                const skill = $(el).text().trim();
                if (skill) requiredSkills.push(skill);
            });
            $('.job-data__item.job-requirement ul li').each((i, el) => {
                const skill = $(el).text().trim();
                if (skill && !requiredSkills.includes(skill)) requiredSkills.push(skill);
            });
            $('.job-data__item.job-requirement .content').each((i, el) => {
                const text = $(el).text().trim();
                if (text) {
                    text.split(/[,.;•\n\t]/).forEach(item => {
                        const trimmedItem = item.trim();
                        if (trimmedItem && trimmedItem.length > 2 && !requiredSkills.includes(trimmedItem)) {
                            requiredSkills.push(trimmedItem);
                        }
                    });
                }
            });
            const uniqueRequiredSkills = [...new Set(requiredSkills.filter(Boolean))];

            let jobDescription = '';
            $('.job-description__item').each((i, el) => {
                const sectionTitle = $(el).find('h3').text().trim();
                const sectionContent = $(el).find('.job-description__item--content').text().trim();
                if (sectionTitle && sectionContent) {
                    jobDescription += `\n--- ${sectionTitle} ---\n${sectionContent}\n`;
                }
            });
            jobDescription = jobDescription.replace(/・/g, '').replace(/\s+\n/g, '\n').trim();

            return {
                requiredSkills: uniqueRequiredSkills,
                description: jobDescription
            };
        } catch (error) {
            console.error(`Lỗi khi lấy chi tiết công việc từ ${jobUrl} (lần thử ${attempt}):`, error.message);
            if (attempt === retries) return null;
            await new Promise(r => setTimeout(r, 5000));
        }
    }

    await page.close();
    return null;
}

crawlTopCV();

process.on('SIGINT', async () => {
    console.log('\n⛔ Dừng thủ công! Đang lưu dữ liệu trước khi thoát...');
    try {
        if (allJobDetails.length > 0) {
            fs.writeFileSync(OUTPUT_FILE, JSON.stringify(allJobDetails, null, 2), 'utf-8');
            console.log(`💾 Đã lưu ${allJobDetails.length} công việc vào ${OUTPUT_FILE}`);
        }
        if (browser) {
            await browser.close();
            console.log('🧹 Đã đóng trình duyệt.');
        }
    } catch (err) {
        console.error('⚠️ Lỗi khi lưu dữ liệu khẩn cấp:', err);
    } finally {
        process.exit(0);
    }
});