AlishaSaldaevaBaza Bot
This is a Telegram bot that provides access to a private channel after a successful payment via Yookassa. The bot uses MongoDB for data storage and is deployed on Render.
Features

Displays a main menu with "Buy for 399 RUB" and "Technical Support" buttons for new users.
Hides "Buy for 399 RUB" button and welcome message for users who have paid and joined the channel.
Shows an "Admin Panel" button in the main menu for the admin (defined by ADMIN_CHAT_ID).
Provides an admin panel with an inline "Export Subscribers" button to download an Excel file with paid users' details (Telegram ID, Name, Username, Phone, Payment Date).
Processes payments via Yookassa with webhook notifications.
Generates one-time, 24-hour expiring invite links for the private channel.
Prevents duplicate payments and allows link renewal with /renew_link.
Checks payment status with /check_payment.
Logs errors and events to the console.
Deployed on Render with webhook support.

Project Structure
alishasaldaevabaza-bot/
├── src/
│   ├── index.js          # Main bot logic
│   ├── yookassa.js       # Yookassa payment handling
├── .env                  # Environment variables
├── package.json          # Dependencies and scripts
├── README.md             # Setup and deployment instructions
└── render.yaml           # Render configuration

Setup Instructions

Clone the repository:
git clone <repository-url>
cd alishasaldaevabaza-bot


Install dependencies:
npm install


Configure environment variables:Create a .env file in the root directory with the following:
BOT_TOKEN=your_telegram_bot_token
MONGODB_URI=your_mongodb_connection_string
YOOKASSA_SHOP_ID=your_yookassa_shop_id
YOOKASSA_SECRET_KEY=your_yookassa_secret_key
CHANNEL_ID=your_telegram_channel_id
ADMIN_CHAT_ID=your_admin_chat_id
RENDER_URL=your-render-url.onrender.com
RETURN_URL=https://your-return-url.com
NODE_ENV=production


BOT_TOKEN: Get from @BotFather in Telegram.
MONGODB_URI: Get from MongoDB Atlas or your MongoDB instance.
YOOKASSA_SHOP_ID and YOOKASSA_SECRET_KEY: Get from Yookassa dashboard.
CHANNEL_ID: ID of your private Telegram channel (e.g., @YourChannel or -1001234567890).
ADMIN_CHAT_ID: Your Telegram ID for receiving payment notifications and accessing the admin panel.
RENDER_URL: Your Render deployment URL (e.g., alishasaldaevabaza-bot.onrender.com).
RETURN_URL: URL for Yookassa payment redirection.


Set up Telegram bot:

Create a bot via @BotFather and get the BOT_TOKEN.
Add the bot as an administrator to your private channel with "Invite users via link" permission.


Set up Yookassa:

Register at Yookassa and obtain SHOP_ID and SECRET_KEY.
Enable test mode for initial testing.
Configure webhook in Yookassa dashboard to: https://your-render-url.onrender.com/webhook/yookassa.


Deploy to Render:

Create a new Web Service on Render.
Select your repository and set the runtime to Node.
Set the start command to npm start.
Add environment variables from .env in the Render dashboard.
Deploy the service.


Set up Telegram webhook:Run the following command to set the webhook:
curl -F "url=https://your-render-url.onrender.com/bot<YOUR_BOT_TOKEN>" https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook


Logging:

Logs are output to the console. Check Render logs for debugging in production.



Testing

Use Yookassa test mode to simulate payments.
Test the /start command to verify the main menu for new users (includes /buy, /support, and /admin for the admin).
Test the /admin command as the admin (use ADMIN_CHAT_ID) to access the inline "Export Subscribers" button.
Verify that the Excel file contains correct user data (Telegram ID, Name, Username, Phone, Payment Date) with proper formatting.
Test the /buy, /support, /check_payment, and /renew_link commands.
Verify that invite links are one-time and expire after 24 hours.
Check that the bot sends admin notifications for successful payments.
Ensure the "Buy for 399 RUB" button is hidden for paid users and the "Admin Panel" button is only visible to the admin.

Notes

Ensure the bot has admin rights in the channel to create invite links.
The RETURN_URL in Yookassa must be a valid URL; update it as needed.
Update the /support command with your actual support contact details (e.g., Telegram username or email).
Monitor console logs in Render for debugging issues.
For production, ensure NODE_ENV=production in .env.
Phone numbers are only available if users share them with Telegram (e.g., via bot settings).
If the MongoDB schema changes, migrate existing data:db.users.updateMany({}, { $set: { firstName: null, username: null, phoneNumber: null, paymentDate: null } });



Troubleshooting

If webhook fails, check Render logs and ensure RENDER_URL is correct.
If payments fail, verify YOOKASSA_SHOP_ID and SECRET_KEY.
If invite links fail, ensure CHANNEL_ID is correct and the bot has admin rights.
If the menu doesn't update, ensure the bot has permission to set commands or restart the chat.
If the Excel file is empty, verify that users have paymentStatus: 'succeeded' and joinedChannel: true in the database.

For support, contact the repository maintainer or check Render console logs.
