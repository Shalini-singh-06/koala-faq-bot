
function getTime() {
  const now = new Date();
  return now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

async function ask() {
  const question = document.getElementById("question").value.trim();
  if (!question) return;

  const chatBox = document.getElementById("chat-box");

  // User bubble
  chatBox.innerHTML += `
    <div class="message user">
      <div class="text">${question}</div>
      <span class="time">${getTime()}</span>
    </div>`;
  document.getElementById("question").value = "";

  // 👇 Add typing bubble
  const typingId = "typing-" + Date.now();
  chatBox.innerHTML += `
    <div class="message bot typing" id="${typingId}">
      <div class="text"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>
    </div>`;
  chatBox.scrollTo({ top: chatBox.scrollHeight, behavior: "smooth" });

  try {
    const res = await fetch("/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question })
    });

    const data = await res.json();

    // Remove typing bubble
    const typingEl = document.getElementById(typingId);
    if (typingEl) typingEl.remove();

    // Bot bubble
    chatBox.innerHTML += `
      <div class="message bot">
        <div class="text">${data.answer}</div>
        <span class="time">${getTime()}</span>
      </div>`;
    chatBox.scrollTo({ top: chatBox.scrollHeight, behavior: "smooth" });
  } catch (err) {
    console.error(err);
  }
}
