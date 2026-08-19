# Mongolbee Messenger Bot — Deploy Guide

## Step 1: Push to GitHub
Create a new GitHub repo, upload index.js and package.json.

## Step 2: Deploy on Render.com (Free)
- render.com → New → Web Service → connect your repo
- Build Command: `npm install`
- Start Command: `npm start`
- Instance Type: Free

## Step 3: Set Environment Variables on Render
| Key | Value |
|-----|-------|
| `VERIFY_TOKEN` | `mongolbee_verify` |
| `PAGE_ACCESS_TOKEN` | From Meta App → Messenger → Generate Token |

## Step 4: Set up Meta App
1. Go to developers.facebook.com → Create App → Business
2. Add "Messenger" product
3. Connect your Mongolbee Facebook Page
4. Generate Page Access Token → paste in Render env vars
5. Webhooks → Add Callback URL:
   - URL: `https://your-app.onrender.com/webhook`
   - Verify Token: `mongolbee_verify`
   - Subscribe to: `messages`, `messaging_postbacks`

## Step 5: Test
Send any message to your Mongolbee Facebook Page.
The bot will reply with a greeting and two sets of buttons.

## What users will see:
```
Сайн байна уу! 👋 Mongolbee-д тавтай морилно уу!
Та юугаар туслуулах вэ?

🛍️ Манай бүтээгдэхүүнүүд:
[ Хөдөлгөөнт Powerpoint ]
[ Бизнес тэмплэт ]
[ Карьер оношилгоо ]

✨ Бусад бүтээгдэхүүнүүд:
[ Бизнес KPI оношилгоо ]
[ Дата скрапер ]
```
Each button opens the product page inside Messenger.
