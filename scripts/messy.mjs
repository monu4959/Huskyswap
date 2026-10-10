// Makes generated text look like students wrote it: typos, abbreviations,
// inconsistent capitalization, emoji, empty descriptions, chat slang.
// Shared by seed-supabase.mjs and simulate-day.mjs. Every function takes R,
// the caller's seeded random helpers { rand, int, pick, chance, weighted }.

const ABBREVIATIONS = [
  [/Calculus/g, "Calc"], [/Introduction to/g, "Intro to"], [/Organic Chemistry/g, "Orgo"],
  [/Principles of Microeconomics/g, "Micro Econ"], [/Principles of Macroeconomics/g, "Macro Econ"],
  [/graphing calculator/gi, "graphing calc"], [/Nintendo Switch/g, "Switch"], [/Mini fridge/gi, "minifridge"],
  [/ with /g, " w/ "], [/ and /g, " & "], [/, (\d+)(st|nd|rd|th) ed\./g, " $1$2 edition"], [/AirPods Pro \(2nd gen\)/g, "airpods pro 2"],
  [/Electric scooter/g, "e-scooter"], [/Bluetooth/g, "BT"], [/monitor/g, "monitor (HDMI)"],
];
const SUFFIXES = [" OBO", " 🔥", " ✨", " !!", " (barely used)", " - cheap", " ASAP", " (pickup only)"];
const GRAD_SUFFIXES = [" - MUST GO", " (moving sale)", " - graduating!", " **everything must go**"];
const DROP_SUFFIXES = [" PRICE DROP", " *reduced*", " (lowered price)", " - still available"];
const SHORT_DESCRIPTIONS = ["dm me", "works", "pick up only", "as pictured", "message for details", "first come first serve", "no lowballers pls"];
const CHAT_SWAPS = [
  [/\byou\b/gi, "u"], [/\bthanks\b/gi, "thx"], [/\blet me know\b/gi, "lmk"], [/\btomorrow\b/gi, "tmrw"],
  [/\bI'm\b/g, "im"], [/\bokay\b/gi, "ok"], [/\bplease\b/gi, "pls"], [/\bbecause\b/gi, "bc"],
];
const EMOJI = ["🙏", "😊", "👍", "😅", "🔥", "!!"];

function typo(word, R) {
  if (word.length < 5) return word;
  const i = R.int(1, word.length - 3);
  switch (R.int(0, 2)) {
    case 0: return word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2); // swap
    case 1: return word.slice(0, i) + word.slice(i + 1); // drop
    default: return word.slice(0, i) + word[i] + word.slice(i); // double
  }
}

// Introduce a typo into one or two words, with probability p
export function messyText(text, R, p = 0.1) {
  if (!text || !R.chance(p)) return text;
  const words = text.split(" ");
  for (let n = R.int(1, 2); n > 0; n--) {
    const i = R.int(0, words.length - 1);
    words[i] = typo(words[i], R);
  }
  return words.join(" ");
}

const clamp = (t) => {
  const out = t.replace(/\s+$/, "").slice(0, 100);
  return out.length >= 3 ? out : "item";
};

export function messyTitle(clean, R, { gradDump = false, priceDrop = false } = {}) {
  let t = clean;
  if (R.chance(0.12)) for (const [re, sub] of ABBREVIATIONS) t = t.replace(re, sub);
  t = messyText(t, R, 0.06);
  if (R.chance(0.12)) t = t.toLowerCase();
  else if (R.chance(0.04)) t = t.toUpperCase();
  if (gradDump && R.chance(0.5)) t += R.pick(GRAD_SUFFIXES);
  else if (priceDrop && R.chance(0.6)) t += R.pick(DROP_SUFFIXES);
  else if (R.chance(0.07)) t += R.pick(SUFFIXES);
  if (R.chance(0.02)) t = t.replace(" ", "  "); // stray double space
  return clamp(t);
}

export function messyDescription(parts, condition, R) {
  if (R.chance(0.07)) return ""; // lazy seller, no description
  if (R.chance(0.06)) return R.pick(SHORT_DESCRIPTIONS);
  let text = parts.filter(Boolean).join(" ");
  // condition picked in the form doesn't always match what the seller writes
  if ((condition === "new" || condition === "like_new") && R.chance(0.04)) text += " Used it for about two years.";
  text = messyText(text, R, 0.1);
  if (R.chance(0.06)) text = text.toLowerCase().replace(/[.,!]/g, "");
  if (R.chance(0.03)) text += " NO LOWBALLERS.";
  if (R.chance(0.03)) text += ` ${R.pick(EMOJI)}`;
  return text.slice(0, 2000);
}

export function messyChat(body, R) {
  let t = body;
  if (R.chance(0.28)) {
    for (const [re, sub] of CHAT_SWAPS) t = t.replace(re, sub);
    t = t.toLowerCase().replace(/[.!]$/, "");
  }
  if (R.chance(0.06)) t += ` ${R.pick(EMOJI)}`;
  return messyText(t, R, 0.04) || body;
}
