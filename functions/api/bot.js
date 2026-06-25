// --- توابع کمکی امن ---
async function sendMessage(token, chatId, text, replyMarkup = null) {
  const payload = { chat_id: chatId, text: text, parse_mode: "HTML" };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

// --- هسته اصلی و امن API ---
export async function onRequestPost(context) {
  const { request, env } = context;
  const db = env.DB;
  const botToken = env.TELEGRAM_TOKEN;
  const secretToken = env.WEBHOOK_SECRET;

  // 🛡️ لایه امنیتی ۱: بررسی هویت تلگرام (جلوگیری از حملات و درخواست‌های جعلی)
  const reqSecret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (reqSecret !== secretToken) {
    return new Response("🚫 Unauthorized request", { status: 403 });
  }

  try {
    const update = await request.json();
    if (!update.message && !update.callback_query) {
      return new Response("OK", { status: 200 });
    }

    const message = update.message || update.callback_query.message;
    const chatId = message.chat.id;
    const fromUser = update.message ? update.message.from : update.callback_query.from;
    const userId = fromUser.id;
    const text = update.message ? update.message.text : null;
    const callbackData = update.callback_query ? update.callback_query.data : null;

    // 🛡️ لایه امنیتی ۲: جلوگیری از SQL Injection با استفاده از bind
    let user = await db.prepare("SELECT * FROM users WHERE telegram_id = ?").bind(userId).first();

    // سیستم ثبت‌نام و احراز هویت اولیه
    if (!user) {
      if (update.message && update.message.contact) {
        const contact = update.message.contact;
        if (contact.user_id !== userId) {
          await sendMessage(botToken, chatId, "❌ لطفا فقط شماره تلفن خودتان را ارسال کنید.");
          return new Response("OK", { status: 200 });
        }
        const phone = contact.phone_number.replace("+", "").trim();
        if (!phone.startsWith("98")) {
          await sendMessage(botToken, chatId, "❌ متأسفانه خدمات این ربات فقط برای ایران فعال است.");
          return new Response("OK", { status: 200 });
        }

        // ثبت کاربر تایید شده
        await db.prepare(`
          INSERT INTO users (telegram_id, full_name, username, phone_number, step, temp_data) 
          VALUES (?, ?, ?, ?, 'IDLE', '{}')
        `).bind(userId, fromUser.first_name || "کاربر", fromUser.username || "", phone).run();
        
        await sendMessage(botToken, chatId, "✅ شماره شما تایید شد! به فروشگاه خوش آمدید.");
        // نمایش منو
        user = { step: 'IDLE', temp_data: '{}' }; 
      } else {
        // قفل کردن دسترسی تا زمان ارسال شماره
        const authMarkup = {
          keyboard: [[{ text: "📱 اشتراک‌گذاری شماره تلفن", request_contact: true }]],
          resize_keyboard: true, one_time_keyboard: true
        };
        await sendMessage(botToken, chatId, "🔐 برای ورود به فروشگاه، لطفاً ابتدا شماره تلفن ایرانی خود را از طریق دکمه زیر به اشتراک بگذارید:", authMarkup);
        return new Response("OK", { status: 200 });
      }
    }

    // بارگذاری دیتای وضعیت ماشین کاربر
    let tempData = JSON.parse(user.temp_data || '{}');
    let currentStep = user.step || 'IDLE';

    // هندل کردن دکمه‌های شیشه‌ای
    if (callbackData) {
      if (callbackData.startsWith('buy_')) {
        const productId = callbackData.split('_');
        const product = await db.prepare("SELECT * FROM products WHERE id = ? AND is_active = 1").bind(productId).first();
        
        if (product) {
          tempData = { product_id: product.id, product_name: product.name, price: product.price };
          await db.prepare("UPDATE users SET step = 'WAITING_USERNAME', temp_data = ? WHERE telegram_id = ?")
            .bind(JSON.stringify(tempData), userId).run();

          await sendMessage(botToken, chatId, `🛒 شما <b>${product.name}</b> را انتخاب کردید.\n\n👇 لطفاً آیدی تلگرام اکانت مقصد را بدون @ ارسال کنید:\n(برای لغو /cancel را بفرستید)`);
        } else {
          await sendMessage(botToken, chatId, "❌ این محصول دیگر موجود نیست.");
        }
      }
      return new Response("OK", { status: 200 });
    }

    // هندل کردن پیام‌های متنی
    if (text) {
      // دستور لغو سراسری
      if (text === '/cancel' || text === '❌ لغو عملیات' || text === '🏠 بازگشت به منوی اصلی') {
        await db.prepare("UPDATE users SET step = 'IDLE', temp_data = '{}' WHERE telegram_id = ?").bind(userId).run();
        
        const mainMenu = {
          keyboard: [
            [{ text: "🛒 خرید تلگرام پریمیوم" }, { text: "⭐ خرید استارز" }],
            [{ text: "🔗 لینک دعوت من" }, { text: "👤 حساب کاربری" }]
          ],
          resize_keyboard: true
        };
        await sendMessage(botToken, chatId, "🏠 به منوی اصلی برگشتید. چه کمکی از من ساخته است؟", mainMenu);
        return new Response("OK", { status: 200 });
      }

      // ماشین وضعیت: دریافت یوزرنیم
      if (currentStep === 'WAITING_USERNAME') {
        // 🛡️ پاک‌سازی ورودی کاربر
        const cleanUsername = text.replace("@", "").trim();
        tempData.target_username = cleanUsername;
        
        await db.prepare("UPDATE users SET step = 'INVOICE', temp_data = ? WHERE telegram_id = ?")
          .bind(JSON.stringify(tempData), userId).run();

        const invoiceText = `🧾 <b>فاکتور خرید شما:</b>\n\n📦 محصول: ${tempData.product_name}\n👤 مقصد: ${tempData.target_username}\n💰 مبلغ قابل پرداخت: ${tempData.price} تومان`;
        
        const paymentMarkup = {
          inline_keyboard: [
            [{ text: "💳 پرداخت (زرین‌پال)", url: `https://your-site.pages.dev/pay?user=${userId}` }],
            [{ text: "❌ لغو عملیات", callback_data: "cancel_order" }]
          ]
        };

        await sendMessage(botToken, chatId, invoiceText, paymentMarkup);
        return new Response("OK", { status: 200 });
      }

      // منوهای اصلی
      if (currentStep === 'IDLE') {
        if (text === '/start') {
          const mainMenu = {
            keyboard: [
              [{ text: "🛒 خرید تلگرام پریمیوم" }, { text: "⭐ خرید استارز" }],
              [{ text: "🔗 لینک دعوت من" }, { text: "👤 حساب کاربری" }]
            ],
            resize_keyboard: true
          };
          await sendMessage(botToken, chatId, "سلام! خدمات مورد نظر خود را انتخاب کنید:", mainMenu);
        }

        else if (text === "🛒 خرید تلگرام پریمیوم" || text === "⭐ خرید استارز") {
          const pType = text.includes("پریمیوم") ? 'premium' : 'stars';
          const products = await db.prepare("SELECT * FROM products WHERE type = ? AND is_active = 1").bind(pType).all();
          
          if (products.results && products.results.length > 0) {
            let inlineKeyboard = [];
            products.results.forEach(p => {
              inlineKeyboard.push([{ text: `${p.name} - ${p.price} تومان`, callback_data: `buy_${p.id}` }]);
            });
            await sendMessage(botToken, chatId, "👇 لطفاً پلن مورد نظر خود را انتخاب کنید:", { inline_keyboard: inlineKeyboard });
          } else {
            await sendMessage(botToken, chatId, "محصولی در این دسته‌بندی فعال نیست.");
          }
        }
      }
    }

  } catch (error) {
    // 🛡️ لایه امنیتی ۳: جلوگیری از کرش شدن ربات در صورت بروز خطای داخلی
    console.error("Critical Error:", error);
    return new Response("Error Handled Safely", { status: 200 }); 
  }

  return new Response("OK", { status: 200 });
}
