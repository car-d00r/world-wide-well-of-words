// Shared frontend logic for every theme draft.
// Talks to the Litestar backend on the same origin (relative URLs).
//
// API contract:
//   POST /api/sentence {sentence, username?}
//        -> {message}                              when the sentence is UNIQUE ("win")
//        -> {message, number_other_submissions}    when it already existed ("lose")
//   GET  /api/sentence-count    -> {count}   total unique sentences in the db
//   GET  /api/submission-count  -> {count}   total submissions across all sentences
//
// EVERY page provides the same five element ids:
//   #form  #username  #sentence  #submit  #result
// ...and calls renderApp() once. The look is 100% CSS per page; this file only
// fills #result with a standard structure and toggles a state class on it:
//   class "win"  | "lose" | "pending"  (plus "show" once there's content)

const API = {
  async check(sentence, username) {
    const res = await fetch("/api/sentence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sentence, username: username || null }),
    });
    if (!res.ok) throw new Error(`server returned ${res.status}`);
    return res.json();
  },
  async sentenceCount() {
    const res = await fetch("/api/sentence-count");
    if (!res.ok) throw new Error(`server returned ${res.status}`);
    return (await res.json()).count;
  },
  async submissionCount() {
    const res = await fetch("/api/submission-count");
    if (!res.ok) throw new Error(`server returned ${res.status}`);
    return (await res.json()).count;
  },
  async leaderboard(limit = 10) {
    const res = await fetch(`/api/leaderboard?limit=${limit}`);
    if (!res.ok) throw new Error(`server returned ${res.status}`);
    return res.json(); // expected: [{username, unique_count, total_count}]
  },
  async randomOriginals(limit = 24) {
    const res = await fetch(`/api/random?limit=${limit}`);
    if (!res.ok) throw new Error(`server returned ${res.status}`);
    return res.json(); // expected: [{sentence, username, count}]
  },
};


const shuffle = (a) => {
  const b = a.slice();
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
};

const isUnique = (r) => r.number_other_submissions == null;

const QUIPS = {
  win: [
    "A genuine first. The corpus has never seen this one.",
    "Original! You just expanded the universe of things said.",
    "Nobody beat you to it. Certified fresh.",
  ],
  lose: [
    "Someone got there first, I'm afraid.",
    "Great minds... this one's been said before.",
    "Not as original as you hoped, huh?",
  ],
};
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function wireForm({ onPending, onResult, onError }) {
  const form = document.getElementById("form");
  const submit = document.getElementById("submit");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const sentence = document.getElementById("sentence").value.trim();
    const username = document.getElementById("username")?.value.trim();
    if (!sentence) return;
    submit.disabled = true;
    onPending && onPending();
    try {
      const r = await API.check(sentence, username);
      const unique = isUnique(r);
      let totals = null;
      if (unique) {
        // Per-user count isn't exposed by the backend yet (see BACKEND_NOTES.md),
        // so a win shows the corpus totals.
        const [uniqueCount, submissionCount] = await Promise.all([
          API.sentenceCount(),
          API.submissionCount(),
        ]);
        totals = { uniqueCount, submissionCount };
      }
      onResult({
        unique,
        sentence,
        username: username || null,
        message: r.message || pick(unique ? QUIPS.win : QUIPS.lose),
        others: r.number_other_submissions,
        totals,
      });
    } catch (err) {
      onError ? onError(err) : alert(err.message);
    } finally {
      submit.disabled = false;
    }
  });
}

// Three-zone renderer: writes stats into #stats (middle third) and the verdict +
// quip into #answer (bottom third), and toggles a state class on <body>
// (state-win / state-lose) so the page can tint its accent.
function renderThirds(opts = {}) {
  const L = Object.assign(
    {
      pending: "checking the corpus…",
      win: "ORIGINAL",
      lose: "ALREADY SAID",
      error: "ERROR",
      uniqueLabel: "unique sentences in the corpus",
      totalLabel: "total submissions ever",
      priorLabel: "times said before",
    },
    opts.labels || {}
  );
  const statsEl = document.getElementById("stats");
  const answerEl = document.getElementById("answer");
  const setState = (cls) => {
    document.body.classList.remove("state-win", "state-lose");
    if (cls) document.body.classList.add(cls);
  };
  const statBlock = (n, l) =>
    `<div class="stat"><div class="num">${n}</div><div class="lbl">${esc(l)}</div></div>`;

  // Side rails (present only on the wide layout): left leaderboard, right
  // random-originals scroller. Both are self-contained and stay put across
  // searches, so they only render once on load.
  const boardEl = document.getElementById("leaderboard");
  if (boardEl) renderLeaderboard(boardEl);
  const scrollEl = document.getElementById("scroller");
  if (scrollEl) renderScroller(scrollEl);

  // Banner submission counter (present on the search-engine layout).
  updateSubmissionCount();

  wireForm({
    onPending: () => {
      setState();
      statsEl.innerHTML = `<div class="muted">${esc(L.pending)}</div>`;
      answerEl.innerHTML = "";
    },
    onError: (e) => {
      setState("state-lose");
      statsEl.innerHTML = "";
      answerEl.innerHTML =
        `<div class="verdict">${esc(L.error)}</div><div class="quip">${esc(e.message)}</div>`;
    },
    onResult: (r) => {
      if (r.unique) {
        setState("state-win");
        statsEl.innerHTML =
          statBlock(r.totals.uniqueCount, L.uniqueLabel) +
          statBlock(r.totals.submissionCount, L.totalLabel);
        answerEl.innerHTML =
          `<div class="verdict">${esc(L.win)}</div><div class="quip">${esc(r.message)}</div>`;
        // A new original belongs in the right rail right away, not after a reload.
        if (scrollEl) addToScroller(scrollEl, { sentence: r.sentence, username: r.username, count: 1 });
      } else {
        setState("state-lose");
        statsEl.innerHTML = statBlock(r.others, L.priorLabel);
        answerEl.innerHTML =
          `<div class="verdict">${esc(L.lose)}</div><div class="quip">${esc(r.message)}</div>`;
      }
      updateSubmissionCount();
    },
  });
}

// Left rail: a "Hall of Fame" leaderboard of the travelers with the most
// original sentences.
async function renderLeaderboard(el) {
  let items;
  items = await API.leaderboard(10);
  if (!Array.isArray(items) || !items.length) items = [];

  el.innerHTML = items
    .map((it, i) => {
      const rank = i + 1;
      const who = it.username ? esc(it.username) : "anonymous";
      const orig = it.unique_count != null ? it.unique_count : 0;
      return (
        `<li><span class="rank r${rank}">${rank}</span>` +
        `<span class="who">${who}</span>` +
        `<span class="score">${orig} <b>orig.</b></span></li>`
      );
    })
    .join("");
}

// Right rail: a slow vertical scroller of random distinct sentences from the
// corpus. Shuffled on load so it feels different every visit; clicking one
// drops it into the search box.
async function renderScroller(el) {
  let items;
  let isSample = false;
  items = await API.randomOriginals(24);
  if (!Array.isArray(items) || !items.length) [items, isSample] = [[], true];
  el._items = shuffle(items);
  el._isSample = isSample;
  drawScroller(el);
}

// Puts a freshly-awarded original at the top of the right rail without a reload.
function addToScroller(el, it) {
  const rest = el._isSample ? [] : (el._items || []).filter((x) => x.sentence !== it.sentence);
  el._items = [it, ...rest];
  el._isSample = false;
  drawScroller(el);
}

function drawScroller(el) {
  const items = el._items;
  const item = (it) => {
    const who = it.username ? esc(it.username) : "some traveler";
    return (
      `<div class="s-item">` +
      `<span class="s-link" data-s="${esc(it.sentence)}">${esc(it.sentence)}</span>` +
      `<span class="s-who">&mdash; ${who}</span></div>`
    );
  };

  // Duplicate for the seamless translateY(-50%) loop, same as the middle feed.
  const rows = items.map(item).join("");
  el.innerHTML = `<div class="scroller-track">${rows}${rows}</div>`;
}

// Banner: total submissions across the whole corpus, shown as a retro counter.
async function updateSubmissionCount() {
  const el = document.getElementById("subcount");
  if (!el) return;
  try {
    const n = await API.submissionCount();
    el.textContent = Number(n).toLocaleString();
  } catch (_) {
    /* leave the current value in place on error */
  }
}

// The one renderer every theme uses. Pass {labels:{...}} to flavor the words.
function renderApp(opts = {}) {
  const L = Object.assign(
    {
      pending: "Checking the corpus…",
      win: "ORIGINAL",
      lose: "ALREADY SAID",
      error: "ERROR",
      uniqueLabel: "unique sentences in the corpus",
      totalLabel: "total submissions ever",
      priorLabel: "times said before",
    },
    opts.labels || {}
  );
  const result = document.getElementById("result");
  const stat = (n, l) =>
    `<div class="r-stat"><span class="r-num">${n}</span><span class="r-label">${l}</span></div>`;

  wireForm({
    onPending: () => {
      result.className = "result show pending";
      result.innerHTML = `<div class="r-pending">${esc(L.pending)}</div>`;
    },
    onError: (e) => {
      result.className = "result show lose";
      result.innerHTML =
        `<div class="r-verdict">${esc(L.error)}</div>` +
        `<div class="r-quip">${esc(e.message)}</div>`;
    },
    onResult: (r) => {
      if (r.unique) {
        result.className = "result show win";
        result.innerHTML =
          `<div class="r-verdict">${esc(L.win)}</div>` +
          `<div class="r-quip">${esc(r.message)}</div>` +
          `<div class="r-stats">${stat(r.totals.uniqueCount, L.uniqueLabel)}${stat(
            r.totals.submissionCount,
            L.totalLabel
          )}</div>`;
      } else {
        result.className = "result show lose";
        result.innerHTML =
          `<div class="r-verdict">${esc(L.lose)}</div>` +
          `<div class="r-quip">${esc(r.message)}</div>` +
          `<div class="r-stats">${stat(r.others, L.priorLabel)}</div>`;
      }
    },
  });
}
