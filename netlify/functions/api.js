exports.handler = async (event, context) => {
  // Налаштування безпеки (CORS), щоб ваш сайт міг спілкуватися з цією функцією
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  };

  // Пропускаємо попередні запити браузера
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  try {
    const path = event.path.replace("/.netlify/functions/api", "");
    
    // 1. ПЕРЕВІРКА ПАРОЛЯ АДМІНА
    if (path === "/admin-login" && event.httpMethod === "POST") {
      const { password } = JSON.parse(event.body || "{}");
      const correctPassword = process.env.ADMIN_PASSWORD;

      if (password === correctPassword) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ success: true, token: "admin-session-granted" })
        };
      } else {
        return {
          statusCode: 401,
          headers,
          body: JSON.stringify({ success: false, error: "Неправильний пароль" })
        };
      }
    }

    // 2. ЗАПИТ ОПЛАТИ В МОНОБАНК (СТВОРЕННЯ БАНКИ/РАХУНКУ)
    if (path === "/create-payment" && event.httpMethod === "POST") {
      const { amount, orderId } = JSON.parse(event.body || "{}");
      const monoToken = process.env.MONO_TOKEN;
      const baseUrl = process.env.BASE_URL || "https://netlify.app";

      if (!monoToken) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: "Токен Монобанку не налаштовано в Netlify" }) };
      }

      // Звертаємося до справжнього API Монобанку
      const response = await fetch("https://monobank.ua", {
        method: "POST",
        headers: {
          "X-Token": monoToken,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          amount: amount * 100, // Переводимо в копійки для Моно
          ccy: 980, // Код гривні
          redirectUrl: `${baseUrl}/success.html`,
          webHookUrl: `${baseUrl}/.netlify/functions/api/monobank-webhook`
        })
      });

      const data = await response.json();
      return {
        statusCode: response.ok ? 200 : response.status,
        headers,
        body: JSON.stringify(data)
      };
    }

    // Якщо шлях не знайдено
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: "Маршрут не знайдено" })
    };

  } catch (error) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message })
    };
  }
};
