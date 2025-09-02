// server.js (drop-in replacement)
import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import { GoogleGenerativeAI } from "@google/generative-ai";
import stringSimilarity from "string-similarity";

dotenv.config();
const app = express();
app.use(express.json());

// ENV flags
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not found in .env");
const EXACT_ANSWER = String(process.env.EXACT_ANSWER || "false").toLowerCase() === "true";

// Setup Gemini
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
const textModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// Load and flatten FAQs (category aware)
const rawFaqs = JSON.parse(fs.readFileSync("koala_living_data.json", "utf-8"));

function flattenFaqs(faqList) {
  const flat = [];
  faqList.forEach(entry => {
    for (const category in entry) {
      const items = entry[category];
      items.forEach(item => {
        if (item.question && item.answer) {
          flat.push({
            category,
            question: item.question,
            answer: item.answer
          });
        }
      });
    }
  });
  return flat;
}
const flatFaqs = flattenFaqs(rawFaqs);

// cosine similarity helper
function cosineSimilarity(a, b) {
  const dot = a.reduce((s, v, i) => s + v * b[i], 0);
  const magA = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
  const magB = Math.sqrt(b.reduce((s, v) => s + v * v, 0));
  if (!magA || !magB) return 0;
  return dot / (magA * magB);
}

// ------- Hard Policies -------
const POLICIES = [
  {
    id: "membership",
    strictAnswer:
      "Koala Living Luxe Memberships are non-refundable and cannot be cancelled or changed once purchased. If you need help with your account or benefits, please contact our customer support team.",
    keywords: [
      "cancel membership",
      "how can i cancel",
      "how do i cancel",
      "terminate membership",
      "end membership",
      "change membership",
      "update membership",
      "modify membership",
      "membership cancellation",
      "luxe membership cancel"
    ],
    threshold: 0.82
  },
  {
    id: "refunds",
    strictAnswer:
      "Koala Living does not offer refunds except where required by law. Instead, we provide Credit Notes or exchanges in line with our Returns Policy.",
    keywords: ["refund", "money back", "return for cash", "get my money", "refund policy"],
    threshold: 0.82
  },
  {
    id: "credit-notes",
    strictAnswer:
      "Credit Notes are non-transferable, cannot be sold, and cannot be exchanged for cash. You may, however, use your Credit Note to place an order for someone else by entering their delivery address.",
    keywords: ["credit note transfer", "sell credit note", "give credit note", "family use credit note"],
    threshold: 0.82
  },
  {
    id: "gift-vouchers",
    strictAnswer:
      "Gift Vouchers are intended for use by the recipient only and cannot be exchanged for cash.",
    keywords: ["gift voucher cash", "sell gift voucher", "transfer gift voucher", "give voucher"],
    threshold: 0.82
  }
];

// Precompute embeddings (FAQ + policy keywords)
let faqEmbeddings = [];      // { question, answer, category, emb }
let policyEmbeddings = [];   // { id, emb, policy }

let embeddingsReady = (async () => {
  console.log("⏳ Precomputing FAQ & policy embeddings...");
  // FAQs
  for (const item of flatFaqs) {
    try {
      const resp = await embeddingModel.embedContent(item.question);
      const vec = resp.embedding.values;
      faqEmbeddings.push({ question: item.question, answer: item.answer, category: item.category, emb: vec });
    } catch (e) {
      console.error("Failed FAQ embedding for:", item.question, e);
    }
  }
  // Policies: join keywords per policy as single text to get a representative embedding
  for (const p of POLICIES) {
    try {
      const text = p.keywords.join(" | ");
      const resp = await embeddingModel.embedContent(text);
      policyEmbeddings.push({ id: p.id, emb: resp.embedding.values, policy: p });
    } catch (e) {
      console.error("Failed policy embedding for:", p.id, e);
    }
  }
  console.log("✅ Embeddings ready");
})();

// Strong policy override: regex direct check → exact keyword includes → embedding fallback
async function checkPolicyOverride(userText) {
  const normalized = (userText || "").toLowerCase().replace(/[^\w\s]/g, " ");

  // Quick regex check for action + target (very fast)
  const actionRe = /\b(cancel|terminate|end|stop|withdraw|close|refund|change|modify)\w*\b/;
  const targetRe = /\b(member|membership|luxe|luxe membership|credit|voucher|refund|note)\b/;
  if (actionRe.test(normalized) && targetRe.test(normalized)) {
    // If exact keyword present in any policy -> fire it
    for (const policy of POLICIES) {
      for (const k of policy.keywords) {
        if (normalized.includes(k)) {
          console.log(`[policy-hit][regex] policy=${policy.id} user="${userText}"`);
          return { hit: true, answer: policy.strictAnswer, policy: policy.id, method: "regex" };
        }
      }
    }
    // If regex matched but no exact keyword, fallback to membership policy as safe default
    const membershipPolicy = POLICIES.find(p => p.id === "membership");
    if (membershipPolicy) {
      console.log(`[policy-hit][regex-fallback] policy=membership user="${userText}"`);
      return { hit: true, answer: membershipPolicy.strictAnswer, policy: membershipPolicy.id, method: "regex-fallback" };
    }
  }

  // Embedding fallback: catches typos and paraphrases
  try {
    await embeddingsReady; // ensure embeddings exist
    const ue = await embeddingModel.embedContent(userText);
    const userEmb = ue.embedding.values;

    let best = { score: -1, policy: null };
    for (const p of policyEmbeddings) {
      const s = cosineSimilarity(userEmb, p.emb);
      if (s > best.score) best = { score: s, policy: p.policy };
    }

    if (best.policy && best.score >= (best.policy.threshold || 0.82)) {
      console.log(`[policy-hit][embedding] policy=${best.policy.id} score=${best.score.toFixed(3)} user="${userText}"`);
      return { hit: true, answer: best.policy.strictAnswer, policy: best.policy.id, score: best.score, method: "embedding" };
    }
  } catch (e) {
    console.warn("Policy embedding check failed:", e);
  }

  return { hit: false };
}

// Find FAQ matches (semantic) - multi-intent split + ranking
async function findMatches(userQ) {
  await embeddingsReady;
  const parts = userQ.split(/ and | or | also |, /i).map(p => p.trim()).filter(Boolean);
  const results = [];

  for (const part of parts) {
    // quick string-similarity candidate first to speed up common cases
    const questions = faqEmbeddings.map(f => f.question);
    const { bestMatch } = stringSimilarity.findBestMatch(part, questions);
    if (bestMatch.rating > 0.55) {
      const matched = faqEmbeddings.find(f => f.question === bestMatch.target);
      if (matched) { results.push(matched); continue; }
    }

    // fallback to embedding ranking
    try {
      const ue = await embeddingModel.embedContent(part);
      const userEmb = ue.embedding.values;
      const ranked = faqEmbeddings
        .map(f => ({ ...f, score: cosineSimilarity(userEmb, f.emb) }))
        .sort((a, b) => b.score - a.score);
      if (ranked[0] && ranked[0].score > 0.75) results.push(ranked[0]);
    } catch (e) {
      console.warn("findMatches embed error:", e);
    }
  }

  // dedupe by question
  const dedup = [];
  const seen = new Set();
  for (const r of results) {
    if (!seen.has(r.question)) {
      dedup.push(r);
      seen.add(r.question);
    }
  }
  return dedup;
}

// API: /ask
app.post("/ask", async (req, res) => {
  const userQ = (req.body.question || "").toString();

  try {
    // 1) policy guardrails (immediate return if hit)
    const policy = await checkPolicyOverride(userQ);
    if (policy.hit) {
      return res.json({ answer: policy.answer, policy: policy.policy || policy.method || "policy" });
    }

    // 2) find FAQ matches
    const matches = await findMatches(userQ);

    // If EXACT_ANSWER mode: return stored FAQ answers verbatim if matched
    if (EXACT_ANSWER && matches.length > 0) {
      const combined = matches.map(m => m.answer).join("\n\n");
      return res.json({ answer: combined, debug: { matched: matches.map(m => ({ q: m.question, category: m.category })) } });
    }

    // 3) Build prompt for Gemini (use FAQs as sources of truth)
    let prompt = `
You are a Koala Living customer support assistant.
Tone: ${process.env.ANSWER_TONE || "Friendly and polite"}
Clarity: ${process.env.ANSWER_CLARITY || "Clear and simple"}
Focus: ${process.env.ANSWER_FOCUS || "Customer-first"}
Answer length: 3-4 sentences max.

User asked: ${userQ}
`;

    if (matches.length > 0) {
      prompt += "\nRelevant FAQ(s):\n";
      matches.forEach((m, i) => {
        prompt += `Q${i + 1}: ${m.question}\nA${i + 1}: ${m.answer}\n\n`;
      });
      prompt += "RULES: Treat the FAQ answers as the source of truth. If the FAQ directly answers the user, echo it closely and do not contradict policy.\n";
    } else {
      prompt += "\nNo relevant FAQ found. Answer directly (concise).\n";
    }

    const result = await textModel.generateContent(prompt);
    // result.response.text() or result.response?.text() depending on the library version
    const aiText = result?.response?.text?.() ?? result?.response?.text ?? result?.candidates?.[0]?.content ?? String(result);
    return res.json({ answer: aiText, debug: { matched: matches.map(m => ({ q: m.question, category: m.category })) } });

  } catch (err) {
    console.error("ERROR /ask:", err);
    res.status(500).json({ error: "AI error" });
  }
});

// Serve static
app.use(express.static("public"));

app.listen(3000, () => console.log("🚀 Server running at http://localhost:3000"));
