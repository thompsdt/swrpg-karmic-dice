// swrpg-karmic-dice/scripts/module.js
// Foundry VTT v12 + StarWarsFFG (SWRPG) system

/* ------------------------------------------------------------------------- */
/* Module identity                                                           */
/* ------------------------------------------------------------------------- */


const MODULE_ID = "swrpg-karmic-dice";
/* ------------------------------------------------------------------------- */
/* Logging helpers                                                           */
/* ------------------------------------------------------------------------- */

function log(...args) {
  console.log(`${MODULE_ID} |`, ...args);
}
function warn(...args) {
  console.warn(`${MODULE_ID} |`, ...args);
}
function error(...args) {
  console.error(`${MODULE_ID} |`, ...args);
}

function _dup(v) {
  try {
    if (foundry?.utils?.duplicate) return foundry.utils.duplicate(v);
    if (typeof structuredClone === "function") return structuredClone(v);
    return JSON.parse(JSON.stringify(v));
  } catch {
    return v;
  }
}



/* ------------------------------------------------------------------------- */
/* Settings + Config UI                                                      */
/* ------------------------------------------------------------------------- */

const KARMIC_SETTINGS = {
  enabled: "enabled",
  debug: "debug",

  // History
  windowSize: "windowSize",
  minSamples: "minSamples",

  // Triggering
  lowThreshold: "lowThreshold",

  // Strength / ramping
  baseBias: "baseBias",
  streakRamp: "streakRamp",
  maxBias: "maxBias",
  maxDeltaRanks: "maxDeltaRanks",

  // Persistence
  persistHistory: "persistHistory",
  state: "state",

  // Force affinity
  affinityMap: "affinityMap",
  defaultAffinity: "defaultAffinity",

forceKarmaEnabled: "forceKarmaEnabled",     // world: disable force adjustments entirely
showAveragesTable: "showAveragesTable",     // client (GM): remember if GM wants the averages panel open


  // Menus
  configMenu: "configMenu"

  
};

function isSettingRegistered(key) {
  try {
    return game?.settings?.settings?.has(`${MODULE_ID}.${key}`);
  } catch {
    return false;
  }
}

function getSetting(key, fallback = undefined) {
  if (!isSettingRegistered(key)) return fallback;
  try {
    return game.settings.get(MODULE_ID, key);
  } catch {
    return fallback;
  }
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/**
 * Returns Actors that have at least one non-GM user with OWNER permission.
 * Used for per-character Force Affinity overrides.
 */
function listOwnedActorsForAffinity() {
  const players = (game.users?.contents ?? []).filter(u => u && !u.isGM);
  const actors = (game.actors?.contents ?? []).filter(a => a);

  const rows = [];
  for (const a of actors) {
    const owners = players.filter(u => {
      try { return a.testUserPermission?.(u, "OWNER"); }
      catch { return false; }
    });
    if (!owners.length) continue;

    rows.push({
      id: a.id,
      name: a.name ?? a.id,
      owners: owners.map(o => o.name ?? o.id)
    });
  }

  rows.sort((x, y) => String(x.name).localeCompare(String(y.name)));
  return rows;
}


function _karmicBiasPreviewText(bias, maxSteps) {
  const b = Math.max(0, Number(bias) || 0);
  const stepsRaw = Math.max(0, Math.floor(Number(maxSteps) || 0));

  if (stepsRaw === 0) {
    return `Preview: Range = 0 → dice never move (bias has no effect).`;
  }

  // Don’t let preview computation explode if someone sets 99/999.
  const steps = Math.min(stepsRaw, 40);

  // Step-weight preview:
  // - "Bias" prefers better options,
  // - but a distance penalty keeps small improvements more likely unless bias (often via ramping) is high.
  const distK = 1.5 / (0.5 + b);

  const weights = [];
  for (let i = 0; i <= steps; i++) {
    const u = i / steps; // 0..1
    weights.push(Math.exp(b * (u - 0.5) - i * distK));
  }

  const sum = weights.reduce((a, c) => a + c, 0) || 1;
  const p = (i) => (weights[i] ?? 0) / sum;
  const pct = (x) => `${Math.round(x * 100)}%`;

  const odds = (weights[steps] ?? 0) / (weights[0] ?? 1);

  // Small ranges: show the exact per-step breakdown.
  if (stepsRaw <= 6) {
    const parts = [];
    parts.push(`no change ${pct(p(0))}`);
    for (let i = 1; i <= stepsRaw; i++) parts.push(`+${i} step ${pct(p(i))}`);
    return `Preview (approx): ${parts.join(", ")}. Best vs worst preference ≈ ${odds.toFixed(1)}×.`;
  }

  // Larger ranges: show grouped summary.
  const p0 = p(0);
  const p1 = p(1);
  const p2 = p(2);
  const pMax = p(steps);
  const mid = Math.max(0, 1 - (p0 + p1 + p2 + pMax));

  const cappedNote = stepsRaw > steps ? ` (preview capped at +${steps})` : "";
  return `Preview (approx, range up to +${stepsRaw}${cappedNote}): no change ${pct(p0)}, +1 ${pct(p1)}, +2 ${pct(p2)}, mid ${pct(mid)}, max ${pct(pMax)}. Best vs worst preference ≈ ${odds.toFixed(1)}×.`;
}


function _wireKarmicBiasUX(html) {
  const root = html?.[0] ?? html;
  if (!root) return;

  const num = root.querySelector('input[name="baseBias"]');
  const range = root.querySelector('input[data-karmic-range="baseBias"]');
  const maxSteps = root.querySelector('input[name="maxDeltaRanks"]');
  const preview = root.querySelector('[data-karmic-bias-preview]');

  const update = () => {
    const b = Number(num?.value ?? 0);
    const s = Number(maxSteps?.value ?? 0);
    if (range) range.value = String(b);
    if (preview) preview.textContent = _karmicBiasPreviewText(b, s);
  };

  // Sync slider -> number
  range?.addEventListener("input", () => { if (num) num.value = range.value; update(); });

  // Sync number -> slider
  num?.addEventListener("input", update);

  // Changing max steps changes the preview meaningfully
  maxSteps?.addEventListener("input", update);

  // Preset buttons
  root.querySelectorAll("button.karmic-preset[data-bias]").forEach(btn => {
    btn.addEventListener("click", () => {
      const v = Number(btn.getAttribute("data-bias") || "0");
      if (num) num.value = String(v);
      if (range) range.value = String(v);
      update();
    });
  });

  // Max-rank-step preset buttons
root.querySelectorAll("button.karmic-steps-preset[data-steps]").forEach(btn => {
  btn.addEventListener("click", () => {
    const steps = Number(btn.getAttribute("data-steps") || "0");
    if (maxSteps) maxSteps.value = String(steps);
    update();
  });
});


  update();
}

function _wireKarmicAveragesUX(html) {
  const root = html?.[0];
  if (!root) return;

  const toggle = root.querySelector('input[name="showAveragesTable"]');
  const wrap = root.querySelector("[data-karmic-avg-wrap]");
  const refreshBtn = root.querySelector(".karmic-avg-refresh");
  const container = root.querySelector("[data-karmic-avg-container]");

  // Store for render function
  _karmicAvgUI.container = container;

  const setVisible = (vis) => {
    if (wrap) wrap.style.display = vis ? "block" : "none";
  };

  const sync = async () => {
    const vis = !!toggle?.checked;
    setVisible(vis);
    // persist instantly (client setting)
    await game.settings.set(MODULE_ID, KARMIC_SETTINGS.showAveragesTable, vis).catch(() => {});
    if (vis) requestPlayerAverages();
  };

  toggle?.addEventListener("change", () => { sync(); });
  refreshBtn?.addEventListener("click", (ev) => {
    ev.preventDefault();
    requestPlayerAverages();
  });

  // On open, if enabled, auto-poll
  if (toggle?.checked) requestPlayerAverages();
}



/**
 * A simple settings “app” for registerMenu that opens a grouped Dialog.
 * (No templates required.)
 */
class KarmicDiceConfigMenu extends FormApplication {
  static _open = false;
  
  render(force = false, options = {}) {
    if (!game.user?.isGM) {
      ui.notifications?.warn("Only the GM can configure Karmic Dice.");
      return this;
    }

    const current = {
      enabled: getSetting(KARMIC_SETTINGS.enabled, true),
      debug: getSetting(KARMIC_SETTINGS.debug, false),

      windowSize: getSetting(KARMIC_SETTINGS.windowSize, 50),
      minSamples: getSetting(KARMIC_SETTINGS.minSamples, 10),

      lowThreshold: getSetting(KARMIC_SETTINGS.lowThreshold, 0.35),

      baseBias: getSetting(KARMIC_SETTINGS.baseBias, 1.2),
      streakRamp: getSetting(KARMIC_SETTINGS.streakRamp, 0.6),
      maxBias: getSetting(KARMIC_SETTINGS.maxBias, 6),
      maxDeltaRanks: getSetting(KARMIC_SETTINGS.maxDeltaRanks, 2),

      persistHistory: getSetting(KARMIC_SETTINGS.persistHistory, true),

      defaultAffinity: getSetting(KARMIC_SETTINGS.defaultAffinity, "light"),
      affinityMap: getSetting(KARMIC_SETTINGS.affinityMap, {})
    };


// UI helper: preserve 0, avoid "||" clobbering valid values
const baseBiasValue = Number.isFinite(Number(current.baseBias))
  ? Number(current.baseBias)
  : 1.2;


    const actors = listOwnedActorsForAffinity().map(a => {
  const v = current.affinityMap?.[a.id];
  return {
    id: a.id,
    name: a.name,
    owners: a.owners,
    value: (v === "light" || v === "dark") ? v : "default"
  };
});

const affinityRows = actors.length ? `
  <div class="form-group">
    <label>Character Overrides</label>
    <div class="form-fields" style="display:block; width:100%;">
      <table class="karmic-affinity-table">
        <thead>
          <tr>
            <th style="text-align:left;">Character</th>
            <th style="text-align:left;">Owners</th>
            <th style="text-align:left;">Affinity</th>
          </tr>
        </thead>
        <tbody>
          ${actors.map(a => `
            <tr>
              <td>${escapeHtml(a.name)}</td>
              <td class="karmic-owners">${escapeHtml((a.owners || []).join(", "))}</td>
              <td>
                <select name="actAff_${a.id}">
                  <option value="default" ${a.value === "default" ? "selected" : ""}>Default</option>
                  <option value="light" ${a.value === "light" ? "selected" : ""}>Light</option>
                  <option value="dark"  ${a.value === "dark"  ? "selected" : ""}>Dark</option>
                </select>
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
    <p class="hint">Only Actors with at least one non-GM Owner permission are listed.</p>
  </div>
` : "";


    const content = `
<style>
  .karmic-config { margin-top: 0; }
  .karmic-config .karmic-lead { margin: 0 0 .5rem; }
  .karmic-config details.karmic-section {
    border: 1px solid rgba(255,255,255,.18);
    border-radius: 6px;
    padding: .4rem .6rem;
    margin: .5rem 0;
    background: rgba(0,0,0,.05);
  }
  .karmic-config details.karmic-section > summary {
    cursor: pointer;
    font-weight: 600;
    list-style: none;
    margin: 0;
    padding: .25rem 0;
  }
  .karmic-config details.karmic-section > summary::-webkit-details-marker { display:none; }
  .karmic-config .karmic-grid-2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: .4rem 1rem;
  }
  @media (max-width: 700px) { .karmic-config .karmic-grid-2 { grid-template-columns: 1fr; } }
  .karmic-config .form-group { margin: .35rem 0; }
  .karmic-config .hint { margin: .15rem 0 0; font-size: 0.9em; }
  .karmic-config .karmic-inline-buttons { display:flex; gap:.35rem; flex-wrap:wrap; margin-top:.35rem; }

  .karmic-config .karmic-inline-buttons button {
    width: auto;
    flex: 0 0 auto;
    padding: .25rem .55rem;
    line-height: 1.1;
  }
  .karmic-config .karmic-subtle { opacity: .9; }
  .karmic-config .karmic-avg-actions { margin: .35rem 0 .25rem; }
</style>

<form class="karmic-config">
  <p class="karmic-lead">
    These settings control how Karmic Dice tracks recent results and nudges future faces to keep averages from drifting too low (or too high, depending on die type).
  </p>

  <details class="karmic-section">
    <summary>General</summary>

    <div class="form-group">
      <label>Enable Karmic Dice</label>
      <div class="form-fields">
        <input type="checkbox" name="enabled" ${current.enabled ? "checked" : ""}/>
      </div>
      <p class="hint">Master switch for interception + adjustment.</p>
    </div>

    <div class="form-group">
  <label>Enable Force Die Karma</label>
  <div class="form-fields">
    <input type="checkbox" name="forceKarmaEnabled"
      ${game.settings.get(MODULE_ID, KARMIC_SETTINGS.forceKarmaEnabled) ? "checked" : ""}/>
  </div>
  <p class="hint">
    If disabled, Force dice are never adjusted by karma (but results are still tracked).
  </p>
</div>


    <div class="form-group">
      <label>Debug Logging (this client)</label>
      <div class="form-fields">
        <input type="checkbox" name="debug" ${current.debug ? "checked" : ""}/>
      </div>
      <p class="hint">Print extra details to the console (only affects whoever enables it).</p>
    </div>
  </details>

  <details class="karmic-section">
    <summary>History and Triggering</summary>

    <div class="karmic-grid-2">
      <div class="form-group">
        <label>History Window Size</label>
        <div class="form-fields">
          <input type="number" name="windowSize" value="${Number(current.windowSize) || 50}" min="1" step="1"/>
        </div>
        <p class="hint">How many recent dice of each type are used for rolling averages (per player).</p>
      </div>

      <div class="form-group">
        <label>Minimum Samples Before Adjusting</label>
        <div class="form-fields">
          <input type="number" name="minSamples" value="${Number(current.minSamples) || 10}" min="0" step="1"/>
        </div>
        <p class="hint">No adjustment until at least this many dice of that type have been recorded.</p>
      </div>
    </div>

    <div class="form-group" style="margin-top:.25rem;">
      <label>Low Average Threshold (0–1)</label>
      <div class="form-fields">
        <input type="number" name="lowThreshold" value="${Number(current.lowThreshold) ?? 0.35}" min="0" max="1" step="0.01"/>
      </div>
      <p class="hint">If a die’s average quality falls below this, Karma begins nudging outcomes.</p>
    </div>
  </details>

  <details class="karmic-section">
    <summary>Adjustment Strength</summary>

    <div class="form-group">
      <label>Max Rank Steps Per Die</label>
      <div class="form-fields">
        <input type="number" name="maxDeltaRanks" value="${Number(current.maxDeltaRanks) || 2}" min="0" step="1"/>
      </div>
      <p class="hint">
        <strong>Distance limit.</strong> When adjustment triggers, a single die can only move this many steps upward in the face-ranking.
        <br>0 = never changes a face • 1 = only to the next better face • 2 = up to two steps, etc.
      </p>

      <div class="karmic-inline-buttons">
        <button type="button" class="karmic-steps-preset" data-steps="1">Conservative</button>
        <button type="button" class="karmic-steps-preset" data-steps="2">Standard</button>
        <button type="button" class="karmic-steps-preset" data-steps="4">Wide</button>
        <button type="button" class="karmic-steps-preset" data-steps="8">Very Wide</button>
        <button type="button" class="karmic-steps-preset" data-steps="99">Unlimited</button>
      </div>

      <p class="hint" style="margin-top:.25rem;">
        Tip: Increasing range makes larger jumps possible, but <strong>Bias</strong> still controls the odds.
      </p>
    </div>

    <div class="form-group">
      <label>
        Help Strength (Bias)
        <i class="fas fa-circle-question"
           style="margin-left:.35rem; opacity:.8;"
           title="Bias does NOT move faces by itself. Max Rank Steps controls how far a die may move. Bias controls how strongly higher-ranked faces are preferred within that allowed range. Each +1 Bias makes the best option about 2.7× more likely than the worst option in the allowed window."></i>
      </label>

      <div class="form-fields" style="gap:.5rem; align-items:center;">
        <input type="range"
               data-karmic-range="baseBias"
               min="0" max="4" step="0.1"
               value="${baseBiasValue}"
               style="flex:1;" />
        <input type="number"
               name="baseBias"
               value="${baseBiasValue}"
               min="0" step="0.1"
               style="width: 90px;" />
      </div>

      <p class="hint">
        How strongly the die is nudged toward higher-ranked faces when adjustment triggers.
        <b>0 = no preference</b>. Higher = stronger preference (not “more steps”).
      </p>

      <p class="hint" style="margin-top:.25rem;">
        <b data-karmic-bias-preview></b>
      </p>

      <div class="karmic-inline-buttons">
        <button type="button" class="karmic-preset" data-bias="0">Off</button>
        <button type="button" class="karmic-preset" data-bias="0.8">Subtle</button>
        <button type="button" class="karmic-preset" data-bias="1.2">Normal</button>
        <button type="button" class="karmic-preset" data-bias="1.8">Strong</button>
        <button type="button" class="karmic-preset" data-bias="2.6">Extreme</button>
      </div>
    </div>

    <details class="karmic-subtle" style="margin:.35rem 0 0;">
      <summary>Advanced ramping</summary>

      <div class="form-group">
        <label>Bias Ramp Per Consecutive Trigger</label>
        <div class="form-fields">
          <input type="number" name="streakRamp" value="${Number(current.streakRamp) ?? 0.6}" min="0" step="0.1"/>
        </div>
        <p class="hint">
          <strong>Escalation when the streak continues.</strong> Each time this die type triggers adjustment on consecutive rolls,
          add this to Bias (Bias = Base + streak×Ramp), up to Max Bias.
          The streak resets when that die type’s average rises above the threshold.
        </p>
      </div>

      <div class="form-group">
        <label>Max Bias</label>
        <div class="form-fields">
          <input type="number" name="maxBias" value="${Number(current.maxBias) || 6}" min="0" step="0.1"/>
        </div>
        <p class="hint">
          <strong>Safety cap.</strong> Limits the maximum preference strength after ramping so adjustment doesn’t become effectively guaranteed.
        </p>
      </div>
    </details>
  </details>

  <details class="karmic-section">
    <summary>Force Affinity</summary>

    <div class="form-group">
      <label>Default Force Affinity</label>
      <div class="form-fields">
        <select name="defaultAffinity">
          <option value="light" ${current.defaultAffinity === "light" ? "selected" : ""}>Light</option>
          <option value="dark"  ${current.defaultAffinity === "dark"  ? "selected" : ""}>Dark</option>
        </select>
      </div>
      <p class="hint">Used for characters that don’t have a specific override below.</p>
    </div>

    ${affinityRows || `<p class="hint">No owned actors found.</p>`}
  </details>

  <details class="karmic-section">
    <summary>Persistence</summary>

    <div class="form-group">
      <label>Persist Per-Player History</label>
      <div class="form-fields">
        <input type="checkbox" name="persistHistory" ${current.persistHistory ? "checked" : ""}/>
      </div>
      <p class="hint">Store karmic history so it survives reloads (per player).</p>
    </div>
  </details>

  ${game.user.isGM ? `
  <details class="karmic-section">
    <summary>GM Tools</summary>

    <div class="form-group">
      <label>Show Player Averages</label>
      <div class="form-fields">
        <input type="checkbox" name="showAveragesTable" ${game.settings.get(MODULE_ID, KARMIC_SETTINGS.showAveragesTable) ? "checked" : ""}/>
      </div>
      <p class="hint">Shows a table of each connected player’s rolling averages per die type (GM only).</p>
    </div>

    <div class="karmic-avg-wrap" data-karmic-avg-wrap
         style="display:${game.settings.get(MODULE_ID, KARMIC_SETTINGS.showAveragesTable) ? "block" : "none"}">
      <div class="karmic-avg-actions">
        <button type="button" class="karmic-avg-refresh">
          <i class="fas fa-rotate-right"></i> Refresh
        </button>
      </div>
      <div class="karmic-avg-container" data-karmic-avg-container>
        <p class="hint">Click Refresh to poll connected players (including this GM client).</p>
      </div>
    </div>
  </details>
  ` : ""}

</form>
    `.trim();

const dlg = new Dialog(
  {
    title: "SWRPG Karmic Dice — Configuration",
    content,
    buttons: {
      save: {
        icon: '<i class="fas fa-save"></i>',
        label: "Save",
        callback: (html) => this._save(html)
      },
      cancel: {
        icon: '<i class="fas fa-times"></i>',
        label: "Cancel"
      }
    },
    default: "save"
  },
  { width: 720 }
);

Hooks.once("renderDialog", (app, html) => {
  if (app?.appId !== dlg.appId) return;
  _wireKarmicBiasUX(html);
  _wireKarmicAveragesUX(html);   
});


dlg.render(true);


    return this;
  }

  async _save(html) {
    const root = html?.[0];
    const form = root?.querySelector("form.karmic-config");
    if (!form) return;

    const fd = new FormData(form);

    const toNum = (name, fallback) => {
      const v = Number(fd.get(name));
      return Number.isFinite(v) ? v : fallback;
    };

    const enabled = !!fd.get("enabled");
    const debug = !!fd.get("debug");

    const forceKarmaEnabled = !!fd.get("forceKarmaEnabled");
await game.settings.set(
  MODULE_ID,
  KARMIC_SETTINGS.forceKarmaEnabled,
  forceKarmaEnabled
);


    const windowSize = Math.max(1, Math.floor(toNum("windowSize", 50)));
    const minSamples = Math.max(0, Math.floor(toNum("minSamples", 10)));

    const lowThreshold = Math.min(1, Math.max(0, toNum("lowThreshold", 0.35)));

    const baseBias = Math.max(0, toNum("baseBias", 1.2));
    const streakRamp = Math.max(0, toNum("streakRamp", 0.6));
    const maxBias = Math.max(0, toNum("maxBias", 6));
    const maxDeltaRanks = Math.max(0, Math.floor(toNum("maxDeltaRanks", 2)));

    const persistHistory = !!fd.get("persistHistory");

    const defaultAffinity = String(fd.get("defaultAffinity") || "light");

    const affinityMap = {};

for (const a of listOwnedActorsForAffinity()) {
  const v = String(fd.get(`actAff_${a.id}`) || "default");
  if (v === "light" || v === "dark") affinityMap[a.id] = v;
}

    await game.settings.set(MODULE_ID, KARMIC_SETTINGS.enabled, enabled);
    await game.settings.set(MODULE_ID, KARMIC_SETTINGS.debug, debug);

    await game.settings.set(MODULE_ID, KARMIC_SETTINGS.windowSize, windowSize);
    await game.settings.set(MODULE_ID, KARMIC_SETTINGS.minSamples, minSamples);

    await game.settings.set(MODULE_ID, KARMIC_SETTINGS.lowThreshold, lowThreshold);

    await game.settings.set(MODULE_ID, KARMIC_SETTINGS.baseBias, baseBias);
    await game.settings.set(MODULE_ID, KARMIC_SETTINGS.streakRamp, streakRamp);
    await game.settings.set(MODULE_ID, KARMIC_SETTINGS.maxBias, maxBias);
    await game.settings.set(MODULE_ID, KARMIC_SETTINGS.maxDeltaRanks, maxDeltaRanks);

    await game.settings.set(MODULE_ID, KARMIC_SETTINGS.persistHistory, persistHistory);

    await game.settings.set(MODULE_ID, KARMIC_SETTINGS.defaultAffinity, defaultAffinity);
    await game.settings.set(MODULE_ID, KARMIC_SETTINGS.affinityMap, affinityMap);

    ui.notifications?.info("Karmic Dice settings saved.");
  }
}



function getPlayerOwnedActors() {
  const actors = game.actors?.contents ?? [];
  const players = game.users?.contents?.filter(u => !u.isGM) ?? [];

  const owned = [];

  for (const actor of actors) {
    const owners = players.filter(u => {
      try {
        if (typeof actor.testUserPermission === "function") {
          return actor.testUserPermission(u, "OWNER");
        }
        const lvl = actor.ownership?.[u.id] ?? 0;
        return lvl >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
      } catch {
        return false;
      }
    });

    if (owners.length) {
      owned.push({
        actor,
        owners: owners.map(o => o.name)
      });
    }
  }

  owned.sort((a, b) => a.actor.name.localeCompare(b.actor.name));
  return owned;
}


/* ------------------------------------------------------------------------- */
/* Dice denomination -> SWFFG tables                                          */
/* ------------------------------------------------------------------------- */

function normalizeDenom(denom) {
  const d = String(denom ?? "?").toLowerCase();

  // Difficulty aliases
  if (d === "i" || d === "difficulty") return "d";

  // Force aliases
  if (d === "force" || d === "w" || d === "f") return "f";

  // Named positives/negatives (defensive)
  if (d === "ability") return "a";
  if (d === "boost") return "b";
  if (d === "proficiency") return "p";
  if (d === "challenge") return "c";
  if (d === "setback") return "s";

  return d;
}

function getFfgResultTableForDenom(denom) {
  const FFG = CONFIG.FFG || {};
  const d = normalizeDenom(denom);

  const FORCE =
    FFG.FORCE_RESULTS ||
    FFG.FORCE_RESULT ||
    FFG.FORCE_DIE_RESULTS ||
    FFG.FORCE_DICE_RESULTS ||
    FFG.FORCE ||
    null;

  const map = {
    // positive
    a: FFG.ABILITY_RESULTS,
    b: FFG.BOOST_RESULTS,
    p: FFG.PROFICIENCY_RESULTS,
    // negative
    d: FFG.DIFFICULTY_RESULTS,
    c: FFG.CHALLENGE_RESULTS,
    s: FFG.SETBACK_RESULTS,
    // force
    f: FORCE
  };

  return map[d] || null;
}

function describeDenom(denom) {
  switch (normalizeDenom(denom)) {
    case "b": return "Boost";
    case "s": return "Setback";
    case "a": return "Ability";
    case "d": return "Difficulty";
    case "p": return "Proficiency";
    case "c": return "Challenge";
    case "f": return "Force";
    default: return denom || "Unknown";
  }
}

/* ------------------------------------------------------------------------- */
/* Face parsing + ranking (Proficiency philosophy)                            */
/* ------------------------------------------------------------------------- */

const _faceRankCache = new Map(); // key: denom|affinity

function _parseCountWord(w) {
  if (w === "One") return 1;
  if (w === "Two") return 2;
  return 0;
}

function _parseDiceLabelKey(labelKey) {
  const k = String(labelKey ?? "");
  const counts = {
    success: 0, advantage: 0, triumph: 0,
    failure: 0, threat: 0, despair: 0,
    light: 0, dark: 0
  };

  if (k.endsWith(".Blank")) return counts;

  const tail = k.split(".").pop() ?? "";
  const tokens = tail.match(/(One|Two)(Success|Advantage|Failure|Threat|Triumph|Despair|Light|Dark|LightSide|DarkSide)/g) ?? [];

  for (const t of tokens) {
    const m = t.match(/^(One|Two)(Success|Advantage|Failure|Threat|Triumph|Despair|Light|Dark|LightSide|DarkSide)$/);
    if (!m) continue;

    const n = _parseCountWord(m[1]);
    const kind = m[2];

    if (kind === "Success") counts.success += n;
    if (kind === "Advantage") counts.advantage += n;
    if (kind === "Failure") counts.failure += n;
    if (kind === "Threat") counts.threat += n;
    if (kind === "Triumph") counts.triumph += n;
    if (kind === "Despair") counts.despair += n;

    if (kind === "Light" || kind === "LightSide") counts.light += n;
    if (kind === "Dark" || kind === "DarkSide") counts.dark += n;
  }

  return counts;
}

function _cmpLex(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const da = (a[i] ?? 0) - (b[i] ?? 0);
    if (da !== 0) return da;
  }
  return 0;
}

/**
 * Build worst->best ranking for a denom using:
 * - Positive (b/a/p): Success (incl Triumph) first, then Triumph, then Advantage
 * - Negative (s/d/c): Despair worst, then Failures (incl Despair), then Threat
 * - Force (f): depends on affinity
 */
function buildFaceRanking(denom, affinity = "light") {
  const d = normalizeDenom(denom);
  const key = `${d}|${affinity}`;
  if (_faceRankCache.has(key)) return _faceRankCache.get(key);

  const table = getFfgResultTableForDenom(d);
  if (!table) return null;

  // In this SWFFG build, result tables are effectively 1-based (keys "1".."N")
  const faces = Object.keys(table)
    .map(k => Number(k))
    .filter(n => Number.isFinite(n))
    .sort((a, b) => a - b);

  const meta = faces.map(face => {
    const entry = table[face];
    const c = _parseDiceLabelKey(entry?.label ?? "");

    let lexKey;
    if (d === "b" || d === "a" || d === "p") {
      const sTotal = c.success + c.triumph;
      lexKey = [sTotal, c.triumph, c.advantage];
    } else if (d === "s" || d === "d" || d === "c") {
      const fTotal = c.failure + c.despair;
      // negative: more bad is worse; invert so worst sorts earlier
      lexKey = [-c.despair, -fTotal, -c.threat];
    } else if (d === "f") {
      const good = (affinity === "dark") ? c.dark : c.light;
      const bad = (affinity === "dark") ? c.light : c.dark;
      lexKey = [good, -bad];
    } else {
      lexKey = [0];
    }

    return { face, lexKey };
  });

  meta.sort((m1, m2) => _cmpLex(m1.lexKey, m2.lexKey));

  const rankWorstToBest = meta.map(m => m.face);
  const rankIndexByFace = {};
  const utilityByFace = {};

  // Tier utility (ties share a tier)
  let tier = -1;
  let lastKey = null;
  for (let i = 0; i < meta.length; i++) {
    const k = meta[i].lexKey.join("|");
    if (k !== lastKey) { tier += 1; lastKey = k; }
    const face = meta[i].face;
    rankIndexByFace[face] = i;
    utilityByFace[face] = tier;
  }

  const built = { faces, rankWorstToBest, rankIndexByFace, utilityByFace, maxTier: tier };
  _faceRankCache.set(key, built);
  return built;
}

/* ------------------------------------------------------------------------- */
/* Weighted resample (bias toward better/worse faces)                         */
/* ------------------------------------------------------------------------- */

function _softmaxSample(weightedFaces) {
  let total = 0;
  for (const w of weightedFaces) total += w.weight;
  if (total <= 0) return weightedFaces[0]?.face ?? null;

  let r = Math.random() * total;
  for (const w of weightedFaces) {
    r -= w.weight;
    if (r <= 0) return w.face;
  }
  return weightedFaces[weightedFaces.length - 1]?.face ?? null;
}

/**
 * Adjust a face by resampling within a local rank window.
 * - bias > 0 biases toward better faces
 * - bias < 0 biases toward worse faces
 * When bias helps (bias>0), we never allow worse outcomes than the original face.
 */
function sampleFaceWeighted({ denom, affinity, originalFace, bias = 0, maxDeltaRanks = 2 }) {
  if (!bias) return originalFace;

  const d = normalizeDenom(denom);
  const ranking = buildFaceRanking(d, affinity);
  if (!ranking) return originalFace;

  const { rankWorstToBest, rankIndexByFace, utilityByFace } = ranking;
  const idx = rankIndexByFace[originalFace];
  if (idx === undefined) return originalFace;

  let lo = Math.max(0, idx - maxDeltaRanks);
  let hi = Math.min(rankWorstToBest.length - 1, idx + maxDeltaRanks);

  // Directional clamp so "help" never makes it worse
  if (bias > 0) lo = idx;
  if (bias < 0) hi = idx;

  const windowFaces = rankWorstToBest.slice(lo, hi + 1);
  if (windowFaces.length <= 1) return originalFace;

  // Normalize utilities inside the window
  const utils = windowFaces.map(f => utilityByFace[f] ?? 0);
  const minU = Math.min(...utils);
  const maxU = Math.max(...utils);
  const span = Math.max(1, maxU - minU);

  const weighted = windowFaces.map(f => {
    const u = utilityByFace[f] ?? 0;
    const uNorm = (u - minU) / span; // 0..1
    const dist = Math.abs((rankIndexByFace[f] ?? idx) - idx);
    const distK = 1.5 / (0.5 + Math.abs(bias));
    const w = Math.exp(bias * (uNorm - 0.5) - dist * distK);
    return { face: f, weight: w };
  });

  return _softmaxSample(weighted) ?? originalFace;
}

/* ------------------------------------------------------------------------- */
/* Per-player state + roll batching                                           */
/* ------------------------------------------------------------------------- */

// Stored per client (each player has their own roll history)
let karmicState = { dice: {} };
let _saveTimer = null;

function _ensureDieState(denom) {
  const d = normalizeDenom(denom);

  // Defensive: older saved state may be {} (no .dice)
  if (!karmicState || typeof karmicState !== "object") karmicState = { dice: {} };
  if (!karmicState.dice || typeof karmicState.dice !== "object") karmicState.dice = {};

  if (!karmicState.dice[d]) karmicState.dice[d] = { history: [], lowStreak: 0 };
  return karmicState.dice[d];
}


function _scheduleSaveState() {
  if (!getSetting(KARMIC_SETTINGS.persistHistory)) return;
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    game.settings.set(MODULE_ID, KARMIC_SETTINGS.state, _dup(karmicState))
      .catch(e => error("Failed saving karmic state", e));
  }, 750);
}

function getForceAffinity(userId, actorId) {
  const map = getSetting(KARMIC_SETTINGS.affinityMap) || {};

  const vActor = actorId ? map?.[actorId] : undefined;
  if (vActor === "light" || vActor === "dark") return vActor;

  // legacy (older versions stored overrides by userId)
  const vUser = userId ? map?.[userId] : undefined;
  if (vUser === "light" || vUser === "dark") return vUser;

  const def = getSetting(KARMIC_SETTINGS.defaultAffinity) || "light";
  return (def === "dark") ? "dark" : "light";
}


function _extractActorIdFromRoll(roll) {
  const o = roll?.options ?? {};
  const speaker = o.speaker ?? o.chatSpeaker ?? null;

  const actorId =
    speaker?.actor ||
    o.actorId ||
    o.actor?.id ||
    roll?.data?.actorId ||
    roll?.data?.actor?.id ||
    null;

  if (actorId) return actorId;

  const tokenId = speaker?.token;
  if (tokenId && canvas?.tokens) {
    const tok = canvas.tokens.get(tokenId);
    const a = tok?.actor;
    if (a?.id) return a.id;
  }

  return game.user?.character?.id || null;
}


function isDebug() {
  return !!getSetting(KARMIC_SETTINGS.debug, false);
}




const _kdDebugCounts = new Map();
function kdDbg(key, msg, limit = 10) {
  if (!isDebug()) return;
  const n = (_kdDebugCounts.get(key) || 0) + 1;
  _kdDebugCounts.set(key, n);
  if (n <= limit) log(`${msg} (#${n})`);
}

// Roll context: commit once per Roll.evaluate so streak = per roll, not per die
const _ctxStack = [];
function _currentCtx() { return _ctxStack[_ctxStack.length - 1] || null; }

function _beginCtx(userId, roll) {
  const ctx = {
    roll,
    userId,
    actorId: _extractActorIdFromRoll(roll),
    facesByDenom: new Map(),
    lowTriggered: new Set()
  };
  _ctxStack.push(ctx);
  kdDbg("ctx:begin", `CTX-BEGIN user=${userId} actor=${ctx.actorId ?? "?"} roll=${roll?.constructor?.name ?? "?"}`);
  return ctx;
}

function _endCtx(ctx) {
  // pop safely
  const top = _currentCtx();
  if (top === ctx) _ctxStack.pop();
  else {
    const i = _ctxStack.lastIndexOf(ctx);
    if (i >= 0) _ctxStack.splice(i, 1);
  }

  const windowSize = Number(getSetting(KARMIC_SETTINGS.windowSize)) || 50;

  for (const [denom, faces] of ctx.facesByDenom.entries()) {
    const dieState = _ensureDieState(denom);

    for (const f of faces) dieState.history.push(f);

    if (dieState.history.length > windowSize) {
      dieState.history.splice(0, dieState.history.length - windowSize);
    }

    // streak updates once per roll per denom
    if (ctx.lowTriggered.has(denom)) dieState.lowStreak += 1;
    else dieState.lowStreak = 0;
  }

  kdDbg("ctx:end", `CTX-END denoms=[${[...ctx.facesByDenom.keys()].join(",")}]`);
  _scheduleSaveState();
  _scheduleAveragesFlagSync();
}

function installRollEvaluatePatch() {
  // We need a roll-batching context while dice terms are being evaluated.
  // StarWarsFFG can bypass Roll.evaluate (e.g., call _evaluate directly or use RollFFG),
  // so we patch a small, explicit set of methods (no broad scanning).
  const patched = [];

  function patchMethod(Cls, methodName, label) {
    const proto = Cls?.prototype;
    if (!proto) return;

    const key = `_karmicPatched_${methodName}`;
    if (Object.prototype.hasOwnProperty.call(proto, key)) return;

    const original = proto[methodName];
    if (typeof original !== "function") return;

    proto[methodName] = function (...args) {
      // Avoid double contexts when evaluate -> _evaluate (or similar) nests.
      const existing = _currentCtx();
      const needsCtx = !existing || existing.roll !== this;

      const ctx = needsCtx ? _beginCtx(game.user.id, this) : existing;

      
      if (needsCtx) kdDbg(`eval:${label}.${methodName}`, `EVAL-HIT ${label}.${methodName} ctor=${this?.constructor?.name ?? "?"}`);
let out;
      try {
        out = original.apply(this, args);
      } catch (e) {
        if (needsCtx) _endCtx(ctx);
        throw e;
      }

      // Preserve sync vs async return types
      if (out && typeof out.then === "function") {
        return out.finally(() => { if (needsCtx) _endCtx(ctx); });
      }

      if (needsCtx) _endCtx(ctx);
      return out;
    };

    proto[key] = true;
    patched.push(`${label}.${methodName}`);
  }

  // Always patch the core Roll class.
  patchMethod(Roll, "evaluate", "Roll");
  patchMethod(Roll, "_evaluate", "Roll");

  // Patch RollFFG if present (explicit, not a wide search).
  const RollFFGClass =
    globalThis.RollFFG ??
    game?.ffg?.RollFFG ??
    CONFIG?.Dice?.RollFFG ??
    null;

  if (RollFFGClass) {
    patchMethod(RollFFGClass, "evaluate", "RollFFG");
    patchMethod(RollFFGClass, "_evaluate", "RollFFG");
  } else {
    warn("RollFFG class not found; relying on Roll/_evaluate patches only.");
  }

  if (patched.length) log(`Patched roll evaluation: ${patched.join(", ")}`);
  else warn("No roll evaluation methods were patched; karmic batching will not run.");
}

/* ------------------------------------------------------------------------- */
/* Bias computation from rolling average + streak ramp                        */
/* ------------------------------------------------------------------------- */

function avgQuality01(denom, affinity) {
  const d = normalizeDenom(denom);
  const dieState = _ensureDieState(d);
  if (!dieState.history.length) return null;

  const ranking = buildFaceRanking(d, affinity);
  if (!ranking) return null;

  const maxTier = Number.isFinite(ranking.maxTier) ? ranking.maxTier : 0;
  if (maxTier <= 0) return 0;

  let sum = 0;
  for (const face of dieState.history) {
    const u = ranking.utilityByFace[face] ?? 0;
    sum += (u / maxTier);
  }

  return sum / dieState.history.length;
}

function computeBiasForDenom(ctx, denom) {
  if (!getSetting(KARMIC_SETTINGS.enabled)) return 0;

  const d = normalizeDenom(denom);

    // Force karma can be disabled entirely
  if (d === "f" && !game.settings.get(MODULE_ID, KARMIC_SETTINGS.forceKarmaEnabled)) {
    return 0;
  }

  const affinity = (d === "f") ? getForceAffinity(ctx.userId, ctx.actorId) : "light";

  const dieState = _ensureDieState(d);

  const minSamples = Number(getSetting(KARMIC_SETTINGS.minSamples)) || 10;
  if (dieState.history.length < minSamples) return 0;

  const avg = avgQuality01(d, affinity);
  if (avg === null) return 0;

  const lowThreshold = Number(getSetting(KARMIC_SETTINGS.lowThreshold));
  const threshold = Number.isFinite(lowThreshold) ? lowThreshold : 0.35;

  if (avg < threshold) {
    const baseBias = Number(getSetting(KARMIC_SETTINGS.baseBias));
    const streakRamp = Number(getSetting(KARMIC_SETTINGS.streakRamp));
    const maxBias = Number(getSetting(KARMIC_SETTINGS.maxBias));

    const b0 = Number.isFinite(baseBias) ? baseBias : 1.2;
    const ramp = Number.isFinite(streakRamp) ? streakRamp : 0.6;
    const bMax = Number.isFinite(maxBias) ? maxBias : 6.0;

    ctx.lowTriggered.add(d);
    return Math.min(bMax, b0 + dieState.lowStreak * ramp);
  }

  return 0;
}

/* ------------------------------------------------------------------------- */
/* Core hook point: applyKarmaFace                                            */
/* ------------------------------------------------------------------------- */

function applyKarmaFace(denom, face, faces) {
// Always track Force faces, even when no adjustment happens
const ctx = _currentCtx();
if (ctx) {
  const d = normalizeDenom(denom);
  if (!ctx.facesByDenom.has(d)) ctx.facesByDenom.set(d, []);
  ctx.facesByDenom.get(d).push(face);
}


  // only operate inside roll-batching context



  const d = normalizeDenom(denom);
if (d === "f" && !game.settings.get(MODULE_ID, KARMIC_SETTINGS.forceKarmaEnabled)) {
  return face; // never adjust force faces
}


  const affinity = (d === "f") ? getForceAffinity(ctx.userId, ctx.actorId) : "light";
  const bias = computeBiasForDenom(ctx, d);
  const maxDeltaRanks = Number(getSetting(KARMIC_SETTINGS.maxDeltaRanks)) || 2;

  const adjusted = sampleFaceWeighted({
    denom: d,
    affinity,
    originalFace: face,
    bias,
    maxDeltaRanks
  });

  return (typeof adjusted === "number") ? adjusted : face;
}

/* ------------------------------------------------------------------------- */
/* Patching FFG dice term classes                                             */
/* ------------------------------------------------------------------------- */

function installKarmicPatchOnTerm(TermClass) {
  if (!TermClass || typeof TermClass.prototype?.roll !== "function") return;

  const denom = TermClass.DENOMINATION || TermClass.denomination || "?";
  if (TermClass.prototype._karmicPatched) return;

  const originalRoll = TermClass.prototype.roll;

  TermClass.prototype.roll = async function karmicRoll(options = {}) {
    const result = await originalRoll.call(this, options);

    try {
      const faces = this.faces || 12;
      const originalFace = result?.result;
      if (typeof originalFace !== "number") return result;

      const adjustedFace = applyKarmaFace(denom, originalFace, faces);
      const finalFace = (typeof adjustedFace === "number") ? adjustedFace : originalFace;

      // Track final face in roll context (each die counts)
      const ctx = _currentCtx();
      if (ctx) {
        const d = normalizeDenom(denom);
        if (!ctx.facesByDenom.has(d)) ctx.facesByDenom.set(d, []);
        ctx.facesByDenom.get(d).push(finalFace);
      }

      if (finalFace !== originalFace) {
        result.result = finalFace;

        const table = getFfgResultTableForDenom(denom);
        if (table && table[finalFace]) {
          result.ffg = table[finalFace];
        }

        result.karmic = {
          dieType: normalizeDenom(denom),
          originalResult: originalFace,
          adjustedResult: finalFace
        };
      }

      if (isDebug()) {
        log(`die=${normalizeDenom(denom)} face=${originalFace} -> ${finalFace}`);
      }

    } catch (e) {
      error("Error applying karmic adjustment to die roll", e);
    }

    return result;
  };

  TermClass.prototype._karmicPatched = true;
  log(`Installed karmic patch on die term: ${TermClass.name} (denom=${denom})`);
}

function installKarmicPatches() {
  if (game.system.id !== "starwarsffg") {
    warn("Not running in Star Wars FFG system; Karmic Dice will be idle.");
    return;
  }

  if (!game.ffg?.diceterms || !Array.isArray(game.ffg.diceterms)) {
    warn("game.ffg.diceterms not found; cannot patch FFG dice terms.");
    return;
  }

  for (const TermClass of game.ffg.diceterms) {
    installKarmicPatchOnTerm(TermClass);
  }
}

/* ------------------------------------------------------------------------- */
/* Chat message hook: add Karmic summary                                     */
/* ------------------------------------------------------------------------- */



function extractKarmicChangesFromRolls(rolls) {
  const changes = [];
  if (!Array.isArray(rolls)) return changes;

  for (const roll of rolls) {
    if (!roll || !Array.isArray(roll.terms)) continue;
    for (const term of roll.terms) {
      if (!term || !Array.isArray(term.results)) continue;
      for (const res of term.results) {
        const k = res && res.karmic;
        if (!k) continue;
        if (typeof k.originalResult !== "number" || typeof k.adjustedResult !== "number") continue;
        if (k.originalResult === k.adjustedResult) continue;
        changes.push({
          dieType: k.dieType || "?",
          originalResult: k.originalResult,
          adjustedResult: k.adjustedResult
        });
      }
    }
  }
  return changes;
}

function renderKarmicSummaryList(changes) {
  if (!changes?.length) {
    return `<div class="karmic-dice-empty">No karmic adjustments were applied.</div>`;
  }

  const grouped = new Map();
  for (const chg of changes) {
    const denom = chg?.dieType ?? "?";
    if (!grouped.has(denom)) grouped.set(denom, []);
    grouped.get(denom).push(chg);
  }

  const groupsHtml = [...grouped.entries()].map(([denom, items]) => {
    const table = getFfgResultTableForDenom(denom);
    const dieName = describeDenom(denom);

    const itemHtml = items.map((chg) => {
      const orig = table?.[chg.originalResult];
      const adj  = table?.[chg.adjustedResult];

      const origLabelRaw = orig?.label ? game.i18n.localize(orig.label) : `Face ${chg.originalResult}`;
      const adjLabelRaw  = adj?.label  ? game.i18n.localize(adj.label)  : `Face ${chg.adjustedResult}`;

      const origLabel = escapeHtml(origLabelRaw);
      const adjLabel  = escapeHtml(adjLabelRaw);

      const origImg = orig?.image
        ? `<img class="karmic-die-face" src="${orig.image}" alt="${origLabel}" title="${origLabel}">`
        : ``;

      const adjImg = adj?.image
        ? `<img class="karmic-die-face" src="${adj.image}" alt="${adjLabel}" title="${adjLabel}">`
        : ``;

      return `
<li class="karmic-dice-change">
  ${origImg}<span class="karmic-face-text">${origLabel}</span>
  <span class="karmic-arrow">→</span>
  ${adjImg}<span class="karmic-face-text">${adjLabel}</span>
</li>`.trim();
    }).join("");

    return `
<li class="karmic-dice-group">
  <div class="karmic-dice-group-title"><strong>${escapeHtml(dieName)}:</strong></div>
  <ul class="karmic-dice-changes">
    ${itemHtml}
  </ul>
</li>`.trim();
  }).join("");

  return `
<div class="karmic-dice-body">
  <ul class="karmic-dice-groups">
    ${groupsHtml}
  </ul>
</div>`.trim();
}

function wireKarmicDetailsInteractions(scopeEl) {
  try {
    if (!scopeEl) return;

    const detailsEls = scopeEl.querySelectorAll('details.karmic-dice-details:not([data-karmic-wired])');
    for (const d of detailsEls) {
      d.setAttribute("data-karmic-wired", "1");

      const summary = d.querySelector("summary");
      if (!summary) continue;

      const stop = (ev) => {
        ev.stopPropagation();
        ev.stopImmediatePropagation();
      };

      summary.addEventListener("click", stop);
      summary.addEventListener("mousedown", stop);
      summary.addEventListener("mouseup", stop);
      summary.addEventListener("pointerdown", stop);
      summary.addEventListener("pointerup", stop);

      d.addEventListener("click", (ev) => ev.stopPropagation());
    }
  } catch (e) {
    error("wireKarmicDetailsInteractions failure", e);
  }
}

Hooks.on("renderChatMessage", (message, html) => {
  try {
    const id = message.id ?? message._id;
    if (!id) return;

    const tryInject = (attempt = 0) => {
      const root = document.querySelector(`li.chat-message[data-message-id="${id}"]`);
      const live = root?.querySelector(`.message-content .starwarsffg.dice-roll`);

      if (!root || !live) {
        if (attempt < 12) return setTimeout(() => tryInject(attempt + 1), 50);
        return;
      }

      if (live.querySelector(".karmic-dice-details")) return;

      const rolls = message.rolls ?? [];
      const changes = extractKarmicChangesFromRolls(rolls);
      if (!changes.length) return;

      const bodyHtml = renderKarmicSummaryList(changes);

      const karmicHtml = `
<div class="karmic-dice-separator"></div>
<details class="karmic-dice-details" open>
  <summary class="karmic-dice-summary">
    <span class="karmic-caret"></span>
    <span>Karmic Dice Adjustments</span>
    <span class="karmic-dice-pill">${changes.length}</span>
  </summary>
  ${bodyHtml}
</details>
      `.trim();

      const diceResult = live.querySelector(".dice-result") ?? live;
      const formula = diceResult.querySelector(".dice-formula");
      if (formula) formula.insertAdjacentHTML("beforebegin", karmicHtml);
      else diceResult.insertAdjacentHTML("afterbegin", karmicHtml);

      wireKarmicDetailsInteractions(live);

      if (isDebug()) log(`Injected karmic UI (${changes.length}) for msg ${id}`);
    };

    tryInject(0);
  } catch (e) {
    error("renderChatMessage failure", e);
  }
});

/* ------------------------------------------------------------------------- */
/* Foundry hooks                                                             */
/* ------------------------------------------------------------------------- */

Hooks.once("init", () => {
  // Single GM config menu (this already contains Force affinity UI)
  game.settings.registerMenu(MODULE_ID, KARMIC_SETTINGS.configMenu, {
    name: "Karmic Dice — Configure",
    label: "Configure",
    hint: "Open the grouped configuration screen (includes Force affinity per user).",
    icon: "fas fa-sliders-h",
    type: KarmicDiceConfigMenu,   // <-- THIS is the class you actually have
    restricted: true
  });

  // Keep the main toggle visible in the normal Foundry settings list
  game.settings.register(MODULE_ID, KARMIC_SETTINGS.enabled, {
    name: "Enable Karmic Dice",
    hint: "Enable/disable karmic adjustments to narrative dice results.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  // Everything else is managed inside the Configure dialog (so hide it here)
  game.settings.register(MODULE_ID, KARMIC_SETTINGS.debug, {
    name: "Debug Logging",
    scope: "client",
    config: false,
    type: Boolean,
    default: false
  });

  // History
  game.settings.register(MODULE_ID, KARMIC_SETTINGS.windowSize, {
    name: "History Window Size",
    scope: "world",
    config: false,
    type: Number,
    default: 50
  });

  game.settings.register(MODULE_ID, KARMIC_SETTINGS.minSamples, {
    name: "Minimum Samples Before Helping",
    scope: "world",
    config: false,
    type: Number,
    default: 10
  });

  // Triggering
  game.settings.register(MODULE_ID, KARMIC_SETTINGS.lowThreshold, {
    name: "Low Average Threshold (0..1)",
    scope: "world",
    config: false,
    type: Number,
    default: 0.35
  });

  // Strength / ramping
  game.settings.register(MODULE_ID, KARMIC_SETTINGS.baseBias, {
    name: "Base Help Strength",
    scope: "world",
    config: false,
    type: Number,
    default: 1.2
  });

  game.settings.register(MODULE_ID, KARMIC_SETTINGS.streakRamp, {
    name: "Ramp Per Consecutive Trigger",
    scope: "world",
    config: false,
    type: Number,
    default: 0.6
  });

  game.settings.register(MODULE_ID, KARMIC_SETTINGS.maxBias, {
    name: "Maximum Help Strength",
    scope: "world",
    config: false,
    type: Number,
    default: 6
  });

  game.settings.register(MODULE_ID, KARMIC_SETTINGS.maxDeltaRanks, {
    name: "Max Rank Steps Per Die",
    scope: "world",
    config: false,
    type: Number,
    default: 2
  });

  // Persistence
  game.settings.register(MODULE_ID, KARMIC_SETTINGS.persistHistory, {
    name: "Persist Per-Player History",
    scope: "client",
    config: false,
    type: Boolean,
    default: true
  });

  // Force karma on/off (world)
game.settings.register(MODULE_ID, KARMIC_SETTINGS.forceKarmaEnabled, {
  name: "Enable Force Karma Adjustments",
  hint: "If disabled, Force dice are never adjusted by karma (history is still recorded).",
  scope: "world",
  config: false,
  type: Boolean,
  default: true
});




  // Force affinity
  game.settings.register(MODULE_ID, KARMIC_SETTINGS.defaultAffinity, {
    name: "Default Force Affinity",
    scope: "world",
    config: false,
    type: String,
    choices: { light: "Light", dark: "Dark" },
    default: "light"
  });

  // Internal/state
  game.settings.register(MODULE_ID, KARMIC_SETTINGS.state, {
    name: "Karmic State (internal)",
    scope: "client",
    config: false,
    type: Object,
    default: { dice: {} }

  });

  game.settings.register(MODULE_ID, KARMIC_SETTINGS.affinityMap, {
    name: "Force Affinity Map (internal)",
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });

  // GM UI preference (client)
game.settings.register(MODULE_ID, KARMIC_SETTINGS.showAveragesTable, {
  name: "Show Player Averages Table",
  hint: "Show the GM-only averages table in the standard Module Settings list.",
  scope: "world",
  config: true,
  restricted: true,
  type: Boolean,
  default: false
});
  // Inject the GM averages table into the standard Module Settings UI
  installKarmicAveragesSettingsUI();

});




Hooks.once("ready", () => {
  try {
    // Load persisted per-client state
    const _loadedState = _dup(getSetting(KARMIC_SETTINGS.state));
karmicState = (_loadedState && typeof _loadedState === "object") ? _loadedState : {};
if (!karmicState.dice || typeof karmicState.dice !== "object") karmicState.dice = {};


    installRollEvaluatePatch();
    installKarmicPatches();
    installKarmicAveragesSocket();

    // Publish this user's current averages for the GM table (debounced).
    _scheduleAveragesFlagSync();


    log("Ready. Karmic dice interception + history tracking active.");
  } catch (e) {
    error("Error during ready initialization", e);
  }
});


// -----------------------------
// GM Averages Table (Module Settings UI)
// -----------------------------

function _ensureKarmicAvgSettingsStyles() {
  try {
    if (document.getElementById("karmic-avg-settings-style")) return;

    const style = document.createElement("style");
    style.id = "karmic-avg-settings-style";
    style.textContent = `
      /* Karmic Dice: GM averages block in Configure Settings */
      .karmic-avg-settings-block {
        margin: 0.5rem 0 0.75rem 0;
      }
      .karmic-avg-settings-block .karmic-avg-table-container {
        width: 100%;
      }
      .karmic-avg-table {
        width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
      }
      .karmic-avg-table th,
      .karmic-avg-table td {
        padding: 0.35rem 0.4rem;
        vertical-align: top;
        white-space: normal;
        word-break: break-word;
      }
      .karmic-avg-table th:first-child,
      .karmic-avg-table td:first-child {
        width: 10rem;
      }
      .karmic-avg-settings-disclaimer {
        margin: 0.35rem 0;
      }
      .karmic-avg-settings-disclaimer p {
        margin: 0.15rem 0;
      }
      .karmic-avg-settings-refresh {
        width: 100%;
        margin-top: 0.35rem;
      }
    `;
    document.head.appendChild(style);
  } catch {
    // ignore
  }
}

function installKarmicAveragesSettingsUI() {
  if (globalThis.__karmicAvgSettingsInstalled) return;
  globalThis.__karmicAvgSettingsInstalled = true;

  Hooks.on("renderSettingsConfig", (app, html) => {
    try {
      if (!game.user?.isGM) return;

      const root = html?.[0];
      if (!root) return;

      _ensureKarmicAvgSettingsStyles();

      // Clean up any old injected panels from earlier versions.
      root.querySelectorAll("[data-karmic-avg-settings-block]").forEach(n => n.remove());
      root.querySelectorAll(".form-group").forEach(fg => {
        const label = fg.querySelector("label");
        if (label && label.textContent?.trim() === "Player Averages (GM)") fg.remove();
      });

      // Find the toggle row for this setting in the standard module settings list.
      const input =
        root.querySelector(`input[name="${MODULE_ID}.${KARMIC_SETTINGS.showAveragesTable}"]`) ||
        root.querySelector(`input[name$=".${KARMIC_SETTINGS.showAveragesTable}"]`);

      if (!input) return;

      const formGroup = input.closest(".form-group");
      if (!formGroup) return;

      const block = document.createElement("div");
      block.className = "karmic-avg-settings-block";
      block.setAttribute("data-karmic-avg-settings-block", "1");
      block.innerHTML = `
        <div class="karmic-avg-table-container" data-karmic-avg-container></div>
        <div class="karmic-avg-settings-disclaimer">
          <p>This polls <em>connected</em> clients. Offline players won’t appear.</p>
          <p>Only connected clients will appear.</p>
        </div>
        <button type="button" class="karmic-avg-settings-refresh karmic-avg-refresh">
          <i class="fas fa-sync"></i> Refresh
        </button>
      `;

      formGroup.insertAdjacentElement("afterend", block);

      const container = block.querySelector("[data-karmic-avg-container]");
      const refreshBtn = block.querySelector(".karmic-avg-refresh");

      if (!container || !refreshBtn) return;

      _karmicAvgUI.container = container;

      const setVisible = (vis) => {
        block.style.display = vis ? "block" : "none";
      };

      const syncVisible = () => {
        setVisible(!!input.checked);
      };

      // Initialize visibility and content.
      syncVisible();
      if (input.checked) {
        _renderPlayerAveragesTable();
        requestPlayerAverages();
      } else {
        container.innerHTML = "";
      }

      // React to toggle changes.
      input.addEventListener("change", () => {
        syncVisible();
        if (input.checked) requestPlayerAverages();
      });

      // Refresh is always below everything and last in the block.
      refreshBtn.addEventListener("click", (ev) => {
        ev.preventDefault();
        requestPlayerAverages();
      });
    } catch (err) {
      console.error(`[${MODULE_ID}] GM averages settings UI injection failed`, err);
    }
  });
}

// -----------------------------
// GM Averages Table (socket poll)
// -----------------------------
const _karmicAvgUI = {
  container: null,
  requestId: null,
  reports: new Map(),
  timeout: null
};

function _escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}

function _fmtPct(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return `${Math.round(v * 100)}%`;
}

// Uses your existing history + avgQuality function(s). Adjust names if yours differ.
function _getLocalAveragesPayload() {
  const denoms = ["b", "a", "p", "s", "d", "c", "f"];
  const out = {};

  for (const denom of denoms) {
    const dieState = _ensureDieState(denom);
    const n = dieState?.history?.length ?? 0;

    if (denom === "f") {
      out.f = {
        n,
        light: n ? avgQuality01("f", "light") : null,
        dark: n ? avgQuality01("f", "dark") : null
      };
    } else {
      out[denom] = {
        n,
        avg: n ? avgQuality01(denom) : null
      };
    }
  }
  return out;
}

const KARMIC_AVG_FLAG = "averages";

function _defaultAveragesPayload() {
  return {
    b: { n: 0, avg: null },
    a: { n: 0, avg: null },
    p: { n: 0, avg: null },
    s: { n: 0, avg: null },
    d: { n: 0, avg: null },
    c: { n: 0, avg: null },
    f: { n: 0, light: null, dark: null }
  };
}

let _karmicAvgFlagSyncTimer = null;

function _scheduleAveragesFlagSync() {
  if (!game?.user) return;
  if (_karmicAvgFlagSyncTimer) return;

  _karmicAvgFlagSyncTimer = setTimeout(() => {
    _karmicAvgFlagSyncTimer = null;
    _syncAveragesFlagNow();
  }, 500);
}

async function _syncAveragesFlagNow() {
  if (!game?.user) return;
  try {
    const payload = _getLocalAveragesPayload?.() ?? _defaultAveragesPayload();
    await game.user.setFlag(MODULE_ID, KARMIC_AVG_FLAG, payload);
  } catch {
    // Ignore: some worlds may restrict flag updates or the user document may be unavailable.
  }
}


function _renderPlayerAveragesTable() {
  const el = _karmicAvgUI.container;
  if (!el) return;

  const users = Array.from(game?.users ?? []).filter(u => u?.active);

  if (!users.length) {
    el.innerHTML = ``;
    return;
  }

  const rows = users.map(u => {
    const userName = `${u.name}${u.isGM ? " (GM)" : ""}`;

    // Prefer fresh socket reports if present; fall back to per-user flags.
    const report = _karmicAvgUI?.reports?.get?.(u.id);
    let payload = report?.payload ?? (u.getFlag?.(MODULE_ID, KARMIC_AVG_FLAG) ?? null);

    // Always render the local user's payload from live state.
    if (u.id === game.user?.id) payload = _getLocalAveragesPayload();

    if (!payload) payload = _defaultAveragesPayload();

    return { userId: u.id, userName, payload };
  }).sort((a, b) => String(a.userName).localeCompare(String(b.userName)));

  const headers = [
    "Player", "Boost", "Ability", "Proficiency",
    "Setback", "Difficulty", "Challenge", "Force (L/D)"
  ];

  const rowHtml = rows.map(r => {
    const p = r.payload || _defaultAveragesPayload();

    const cell = (k) => {
      const o = p[k];
      if (!o) return `— <span class="karmic-avg-n">(n=0)</span>`;
      return `${_fmtPct(o.avg)} <span class="karmic-avg-n">(n=${o.n ?? 0})</span>`;
    };

    const forceCell = (() => {
      const f = p.f;
      if (!f) return `— / — <span class="karmic-avg-n">(n=0)</span>`;
      return `${_fmtPct(f.light)} / ${_fmtPct(f.dark)} <span class="karmic-avg-n">(n=${f.n ?? 0})</span>`;
    })();

    return `
      <tr>
        <td><strong>${_escapeHtml(r.userName)}</strong></td>
        <td class="karmic-avg-cell">${cell("b")}</td>
        <td class="karmic-avg-cell">${cell("a")}</td>
        <td class="karmic-avg-cell">${cell("p")}</td>
        <td class="karmic-avg-cell">${cell("s")}</td>
        <td class="karmic-avg-cell">${cell("d")}</td>
        <td class="karmic-avg-cell">${cell("c")}</td>
        <td class="karmic-avg-cell">${forceCell}</td>
      </tr>
    `;
  }).join("");

  el.innerHTML = `
    <table class="karmic-avg-table">
      <thead>
        <tr>${headers.map(h => `<th>${_escapeHtml(h)}</th>`).join("")}</tr>
      </thead>
      <tbody>${rowHtml}</tbody>
    </table>
`;
}


function installKarmicAveragesSocket() {
  const channel = `module.${MODULE_ID}`;
  if (globalThis.__karmicAvgSocketBound) return;
  globalThis.__karmicAvgSocketBound = true;

  game.socket.on(channel, (data) => {
    if (!data || !data.op) return;

    // Everyone responds to requests
    if (data.op === "karmic-avg-request") {
      _scheduleAveragesFlagSync();
      const payload = _getLocalAveragesPayload();
      game.socket.emit(channel, {
        op: "karmic-avg-report",
        requestId: data.requestId,
        to: data.from,
        from: game.user.id,
        userName: (game.user.isGM ? `${game.user.name} (GM)` : `${game.user.name}`),
        payload
      });
      return;
    }

    // Only the targeted GM consumes reports
    if (data.op === "karmic-avg-report") {
      if (!game.user.isGM) return;
      if (data.to !== game.user.id) return;
      if (!_karmicAvgUI.requestId || data.requestId !== _karmicAvgUI.requestId) return;

      _karmicAvgUI.reports.set(data.from, {
        userId: data.from,
        userName: data.userName,
        payload: data.payload
      });
      _renderPlayerAveragesTable();
    }
  });
}

function requestPlayerAverages() {
  if (!game.user?.isGM) return;
  const channel = `module.${MODULE_ID}`;

  const rid = foundry?.utils?.randomID ? foundry.utils.randomID(16) : `${Date.now()}-${Math.random()}`;
  _karmicAvgUI.requestId = rid;
  _karmicAvgUI.reports.clear();

  if (_karmicAvgUI.container) {
    _karmicAvgUI.container.innerHTML = `<p class="hint">Refreshing…</p>`;
  }

  // Update this user's published averages immediately.
  _syncAveragesFlagNow();

  // Render immediately (connected users appear even if their payload hasn't arrived yet).
  _renderPlayerAveragesTable();

  // Ask other clients to report (they also publish their averages to flags).
  game.socket.emit(channel, { op: "karmic-avg-request", requestId: rid, from: game.user.id });

  if (_karmicAvgUI.timeout) clearTimeout(_karmicAvgUI.timeout);
  _karmicAvgUI.timeout = setTimeout(() => {
    _karmicAvgUI.timeout = null;
    _renderPlayerAveragesTable();
  }, 750);
}


