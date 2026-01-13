import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import Redis from "ioredis";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import rateLimit from "express-rate-limit";

dotenv.config();

console.log("🔥 CallFlow Backend starting (Phase 8 – Hardened SaaS)");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// --------------------
// Rate limiting (PHASE 8)
// --------------------
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_PER_MIN || 60),
});
app.use(limiter);

// --------------------
// Clients
// --------------------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const redis = new Redis(process.env.REDIS_URL);

// --------------------
// Audio setup
// --------------------
const AUDIO_DIR = "./audio";
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR);
app.use("/audio", express.static(path.resolve(AUDIO_DIR)));

// --------------------
// Redis key helpers (MULTI-TENANT)
// --------------------
const tenantKey = (tid) => `tenant:${tid}:config`;
const sessionKey = (tid, sid) => `tenant:${tid}:call:session:${sid}`;
const logKey = (tid, sid) => `tenant:${tid}:call:log:${sid}`;
const analyticsKey = (tid) =>
  `tenant:${tid}:analytics:daily:${new Date().toISOString().slice(0, 10)}`;

// --------------------
// Helpers
// --------------------
async function getTenantConfig(tenantId) {
  const data = await redis.get(tenantKey(tenantId));
  return data
    ? JSON.parse(data)
    : {
        businessName: "CallFlow Client",
        businessHours: "10 AM to 6 PM",
        humanAgent: process.env.HUMAN_AGENT_NUMBER,
        aiStyle: "polite and professional",
        enableHumanTransfer: true,
      };
}

async function generateSpeech(text, filePath) {
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice: process.env.OPENAI_TTS_VOICE || "alloy",
      input: text,
    }),
  });

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(filePath, buffer);
}

// --------------------
// Health check
// --------------------
app.get("/", (_, res) => {
  res.send("CallFlow SaaS backend is alive");
});

// --------------------
// Incoming call
// --------------------
app.post("/incoming-call", async (req, res) => {
  const callSid = req.body.CallSid;
  const tenantId = req.body.To;

  console.log("📞 Incoming call:", callSid, "Tenant:", tenantId);

  const tenant = await getTenantConfig(tenantId);

  const session = {
    callSid,
    tenantId,
    from: req.body.From,
    intent: null,
    startTime: Date.now(),
    resolvedBy: "AI",
    messages: [
      {
        role: "system",
        content: `You are an AI receptionist for ${tenant.businessName}.
Style: ${tenant.aiStyle}.
Business hours: ${tenant.businessHours}.`,
      },
    ],
  };

  await redis.set(
    sessionKey(tenantId, callSid),
    JSON.stringify(session),
    "EX",
    3600
  );

  const welcomeText = `Hello. You have reached ${tenant.businessName}. How can I help you today?`;
  const audioFile = `${AUDIO_DIR}/${callSid}-welcome.mp3`;
  await generateSpeech(welcomeText, audioFile);

  res.type("text/xml").send(`
<Response>
  <Play>${req.protocol}://${req.get("host")}/audio/${path.basename(
    audioFile
  )}</Play>
  <Gather input="speech" action="/process-speech" method="POST" timeout="5"/>
</Response>
  `);
});

// --------------------
// Process speech
// --------------------
app.post("/process-speech", async (req, res) => {
  const callSid = req.body.CallSid;
  const tenantId = req.body.To;
  const userSpeech = req.body.SpeechResult || "";

  let session = await redis.get(sessionKey(tenantId, callSid));
  if (!session) return res.sendStatus(200);
  session = JSON.parse(session);

  // --------------------
  // PHASE 8 limits
  // --------------------
  if (session.messages.length / 2 > Number(process.env.MAX_CALL_TURNS || 20)) {
    session.resolvedBy = "LIMIT";
    await redis.set(
      sessionKey(tenantId, callSid),
      JSON.stringify(session),
      "EX",
      3600
    );

    return res.type("text/xml").send(`
<Response>
  <Say>This call has reached its maximum length. Thank you.</Say>
</Response>
    `);
  }

  if (
    (Date.now() - session.startTime) / 1000 >
    Number(process.env.MAX_CALL_DURATION_SEC || 900)
  ) {
    session.resolvedBy = "TIME_LIMIT";
    await redis.set(
      sessionKey(tenantId, callSid),
      JSON.stringify(session),
      "EX",
      3600
    );

    return res.type("text/xml").send(`
<Response>
  <Say>This call has timed out. Thank you.</Say>
</Response>
    `);
  }

  const tenant = await getTenantConfig(tenantId);
  const lower = userSpeech.toLowerCase();

  session.messages.push({ role: "user", content: userSpeech });

  // --------------------
  // Human transfer
  // --------------------
  if (
    tenant.enableHumanTransfer &&
    ["human", "agent", "person", "operator"].some((k) =>
      lower.includes(k)
    )
  ) {
    session.resolvedBy = "HUMAN";
    await redis.set(
      sessionKey(tenantId, callSid),
      JSON.stringify(session),
      "EX",
      3600
    );

    return res.type("text/xml").send(`
<Response>
  <Play>Please hold while I connect you.</Play>
  <Dial>${tenant.humanAgent}</Dial>
</Response>
    `);
  }

  // --------------------
  // Intent detection (once)
  // --------------------
  if (!session.intent) {
    const intentCheck = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "Classify intent: sales, support, info, or unknown. One word only.",
        },
        { role: "user", content: userSpeech },
      ],
    });

    session.intent = intentCheck.choices[0].message.content.trim();
    console.log("🎯 Intent:", session.intent);
  }

  // --------------------
  // AI reply
  // --------------------
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.3,
    messages: session.messages,
  });

  const reply = completion.choices[0].message.content;
  session.messages.push({ role: "assistant", content: reply });

  await redis.set(
    sessionKey(tenantId, callSid),
    JSON.stringify(session),
    "EX",
    3600
  );

  const audioFile = `${AUDIO_DIR}/${callSid}-${Date.now()}.mp3`;
  await generateSpeech(reply, audioFile);

  res.type("text/xml").send(`
<Response>
  <Play>${req.protocol}://${req.get("host")}/audio/${path.basename(
    audioFile
  )}</Play>
  <Gather input="speech" action="/process-speech" method="POST" timeout="5"/>
</Response>
  `);
});

// --------------------
// Call ended → analytics + logs
// --------------------
app.post("/call-ended", async (req, res) => {
  const callSid = req.body.CallSid;
  const tenantId = req.body.To;

  let session = await redis.get(sessionKey(tenantId, callSid));
  if (!session) return res.sendStatus(200);
  session = JSON.parse(session);

  const durationSec = Math.floor(
    (Date.now() - session.startTime) / 1000
  );

  await redis.set(
    logKey(tenantId, callSid),
    JSON.stringify({
      ...session,
      durationSec,
      endedAt: new Date().toISOString(),
    })
  );

  await redis.hincrby(analyticsKey(tenantId), "total_calls", 1);
  await redis.hincrby(
    analyticsKey(tenantId),
    `resolved_${session.resolvedBy}`,
    1
  );

  await redis.del(sessionKey(tenantId, callSid));
  res.sendStatus(200);
});

// --------------------
// Start server
// --------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`✅ CallFlow SaaS backend running on port ${PORT}`);
});
