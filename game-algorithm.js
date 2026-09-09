// ============================================================================
// Bee Colony / Honey Farm — idle-colony simulation algorithm (single file).
// Everything below (state, formulas, tick loop, DOM rendering) lives here so
// it can be dropped into index.html as one <script> and read/reasoned about
// as a single unit.
// ============================================================================

(() => {
  const TICK_MS = 1000;

  // ---- tunable balance constants -------------------------------------------------
  const BASE_EGG_RATE_PER_MIN = 2;     // eggs/min at queen level 0
  const EGG_RATE_PER_LEVEL = 0.6;      // extra eggs/min per queen level

  const STAGE_DURATION_SEC = { egg: 30, larva: 45, pupa: 60 }; // base seconds/stage

  const HONEY_PER_PROCESSOR_PER_MIN = 6;   // nectar consumed 1:1 -> honey produced
  const HONEY_CONVERT_SEC = 5;             // one bee converts one Nectar into one Honey
  const WAX_PER_BUILDER_PER_MIN = 1.5;
  const JELLY_CHANCE_PER_NURSE_PER_TICK = 0.01;

  // Nectar Hive workforce splits into two bee types:
  //   - Nectar Forager ("pencari nektar") : individual round-trip bees, +1 Nectar per return trip.
  //   - Food Forager ("pencari makanan")  : continuous Pollen gathering (unchanged formula).
  const NECTAR_HIVE_SUBSPLIT = { nectarForager: 0.6, foodForager: 0.4 };
  // Nectar Forager bee lifecycle: out (searching, hidden) -> arriving (flying in) ->
  // depositing (sitting at the Nectar Hive, +1 Nectar) -> leaving (flying out) -> out again.
  const NECTAR_OUT_SEC = { min: 4, max: 8 };
  const NECTAR_ARRIVE_SEC = { min: 1, max: 1.5 };
  const NECTAR_DEPOSIT_SEC = { min: 1.5, max: 2.5 };
  const NECTAR_LEAVE_SEC = { min: 1, max: 1.5 };
  // Food Foragers return with a randomly selected insect prey each trip.
  const FOOD_FORAGER_PREY = ['🐛', '🪲', '🐞', '🦗', '🪰'];

  // Only 3 hive types exist, each with exactly one job. Workforce ratios sum to 1.
  //   - Nectar Hive   : Nectar Foragers + Food Foragers, gather Nectar + Pollen from the meadow.
  //   - Storage Hive  : nurses tend Brood ("insects") and guard the food stockpile.
  //   - Honey Hive(s) : builders + "pengubah madu" (Honey Makers), turn Nectar/Beeswax into Honey.
  const HIVE_WORKFORCE_SPLIT = { nectarHive: 0.4, storageHive: 0.25, honeyHives: 0.35 };
  const HONEY_HIVE_SUBSPLIT = { builder: 0.15 / 0.35, processor: 0.20 / 0.35 };

  // Every hive (of any type) holds up to this many units of food (0/50 empty, 50/50 full).
  const HIVE_CAPACITY_PER_HIVE = 53;

  const HONEYCOMB_WAX_COST = 40; // wax spent per honeycomb build (cosmetic milestone, no cap effect)

  const queenLevelUpCost = (level) => Math.round(10 + level * 6);        // royal jelly (uncapped, not "food")
  const hiveLevelUpCost = (level) => ({ honey: level * 40, beeswax: level * 8 }); // resources
  const LEVEL_UP_COOLDOWN_MS = 4000;

  // Honey Hive count grows with hive level ("the rest" of the hives). Nectar Hive and
  // Storage Hive both start at 1 and can be increased later via growHiveCount(type).
  function getHoneyHiveCount(hiveLevel) {
    return Math.max(1, hiveLevel - 1);
  }

  // ---- mutable game state ---------------------------------------------------------
  const state = {
    resources: { honey: 20, nectar: 10, pollen: 3, beeswax: 5, jelly: 12 },
    // Honey kept in the jar is separate from the colony resources used by the simulation.
    // It starts empty and only increases when the player harvests a full Honey Hive.
    honeyStorage: 0,
    hives: {
      nectar: { count: 1 },
      storage: { count: 1 },
      // Honey Hive is boolean per instance: full=true means "ready, click to collect";
      // full=false means a bee is working there, filling it back up.
      honey: { count: getHoneyHiveCount(4), instances: [] },
    },
    bank: { honeyCollected: 0 },
    queen: { level: 5 },
    hive: { level: 4, maxWorkers: 10 },
    colony: {
      total:5,
      workers:0,
      brood: { eggs: 4, eggProgress: 0, larva: 4, larvaProgress: 0, pupa: 4, pupaProgress: 0 },
      happiness: 86,
      nectarForagerAssigned: 0,
      foodForagerAssigned: 0,
    },
    // Individual Nectar/Food Forager bees: each does its own out-and-back trip, +1 resource on return.
    bees: {
      nectarForagers: [],
      foodForagers: [],
      free: [],
      // Only bees that have reached the entrance become active foragers. This lets a
      // newly assigned free bee visibly fly home before it starts its new role.
      assigned: { nectar: 3, food: 3 },
    },
    // Player-adjustable via the Nectar Hive popup's +/- buttons.
    nectarForagerAssigned: 3,
    foodForagerAssigned: 3,

    // Player-adjustable via the Storage Hive popup's +/- buttons.
    nurseAssigned: 5,
    wax: { buildProgress: 0 },
    lastQueenLevelUpAt: 0,
    lastHiveLevelUpAt: 0,
    lastHoneyRate: 0,
    lastEggRate: 0,
  };

  // Every food resource (honey+nectar+pollen+beeswax) shares one Storage Hive pool.
  // Nectar/Honey Hives additionally cap their own resource individually.
  function getCaps(s) {
    return {
      storage: s.hives.storage.count * HIVE_CAPACITY_PER_HIVE,
      nectarHive: s.hives.nectar.count * HIVE_CAPACITY_PER_HIVE,
    };
  }

  // Honey Hives are discrete cells: empty -> working -> full. Each full cell holds 1 Honey.
  function syncHoneyHiveInstances(s) {
    const instances = s.hives.honey.instances;
    while (instances.length < s.hives.honey.count) {
      instances.push({ status: 'empty', incoming: false, timer: 0 });
    }
    instances.length = s.hives.honey.count;
  }

  const randomSec = (range) => range.min + Math.random() * (range.max - range.min);

  // Keeps one { phase, timer, total } instance per forager bee, adding new ones as count grows.
  // `total` mirrors the current phase's duration so flight progress (0..1) can be rendered.
  function syncForagerBees(bees, count) {
    while (bees.length < count) {
      const total = randomSec(NECTAR_OUT_SEC);
      bees.push({ phase: 'out', timer: total * Math.random(), total }); // staggered start
    }
    bees.length = count;
  }

  // Unassigned bees are visual-only: they roam unpredictably across the game screen.
  function syncFreeBees(bees, count) {
    while (bees.length < count) {
      bees.push({
        left: 8 + Math.random() * 84,
        top: 18 + Math.random() * 64,
        timer: Math.random() * 3,
        flightSec: 2.5 + Math.random() * 3.5,
        facing: Math.random() > 0.5 ? 1 : -1,
      });
    }
    bees.length = count;
  }

  function getGameFrameSpot(selector, fallback) {
    const frame = document.querySelector('.game-frame');
    const el = document.querySelector(selector);
    if (!frame || !el) return fallback;
    const frameRect = frame.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    return {
      left: ((elRect.left + elRect.width / 2 - frameRect.left) / frameRect.width) * 100,
      top: ((elRect.top + elRect.height / 2 - frameRect.top) / frameRect.height) * 100,
    };
  }

  // Sends one or more free bees to the entrance. They remain visually free until the
  // flight ends, at which point they are promoted to their requested forager role.
  function queueFreeBeeHandoffs() {
    const desired = {
      nectar: state.colony.nectarForagerAssigned,
      food: state.colony.foodForagerAssigned,
    };
    const assigned = state.bees.assigned;
    const entrance = getGameFrameSpot('.hive-entrance-hole', { left: 10, top: 72 });

    for (const role of ['nectar', 'food']) {
      // Releasing a forager is immediate; assigning one uses the smooth handoff below.
      if (desired[role] < assigned[role]) assigned[role] = desired[role];

      const alreadyFlyingHome = state.bees.free.filter((bee) => bee.handoff === role).length;
      const needed = Math.max(0, desired[role] - assigned[role] - alreadyFlyingHome);
      const candidates = state.bees.free.filter((bee) => !bee.handoff).slice(0, needed);
      for (const bee of candidates) {
        const startLeft = bee.left;
        bee.handoff = role;
        bee.left = entrance.left;
        bee.top = entrance.top;
        bee.flightSec = 1.35 + Math.random() * 1.1;
        bee.timer = bee.flightSec;
        bee.facing = entrance.left >= startLeft ? 1 : -1;
      }
    }
  }

  function advanceFreeBees(bees, count, dtSeconds) {
    syncFreeBees(bees, count);
    queueFreeBeeHandoffs();
    const arrived = { nectar: 0, food: 0 };
    for (let index = bees.length - 1; index >= 0; index--) {
      const bee = bees[index];
      bee.timer -= dtSeconds;
      if (bee.handoff) {
        if (bee.timer <= 0) {
          if (bee.handoff.startsWith('honey:')) {
            const hiveIndex = Number(bee.handoff.split(':')[1]);
            const hive = state.hives.honey.instances[hiveIndex];
            if (hive && hive.incoming) {
              hive.incoming = false;
              hive.status = 'working';
              hive.timer = HONEY_CONVERT_SEC;
            }
          } else {
            arrived[bee.handoff] += 1;
          }
          bees.splice(index, 1);
        }
        continue;
      }
      if (bee.timer > 0) continue;
      bee.left = 6 + Math.random() * 88;
      bee.top = 16 + Math.random() * 68;
      bee.flightSec = 2.5 + Math.random() * 4.5;
      bee.timer = bee.flightSec * (0.55 + Math.random() * 0.6);
      bee.facing = Math.random() > 0.5 ? 1 : -1;
    }
    state.bees.assigned.nectar += arrived.nectar;
    state.bees.assigned.food += arrived.food;
  }

  function advanceHoneyHives(dtSeconds) {
    let completed = 0;
    for (const hive of state.hives.honey.instances) {
      if (hive.status !== 'working') continue;
      hive.timer -= dtSeconds;
      if (hive.timer <= 0) {
        hive.timer = 0;
        hive.status = 'full';
        completed += 1;
      }
    }
    return completed;
  }

  // A free bee takes 1 Nectar and flies to an empty Honey Hive to convert it.
  function dispatchHoneyWorker() {
    if (state.resources.nectar < 1 || state.bees.free.some((bee) => bee.handoff)) return;
    const hiveIndex = state.hives.honey.instances.findIndex((hive) => hive.status === 'empty' && !hive.incoming);
    const bee = state.bees.free.find((candidate) => !candidate.handoff);
    if (hiveIndex < 0 || !bee) return;

    const hiveSpot = getGameFrameSpot(`.honey-hive[data-honey-index="${hiveIndex}"]`, { left: 52, top: 64 });
    const startLeft = bee.left;
    state.resources.nectar -= 1;
    state.hives.honey.instances[hiveIndex].incoming = true;
    bee.handoff = `honey:${hiveIndex}`;
    bee.left = hiveSpot.left;
    bee.top = hiveSpot.top;
    bee.flightSec = 1.35 + Math.random() * 1.1;
    bee.timer = bee.flightSec;
    bee.facing = hiveSpot.left >= startLeft ? 1 : -1;
  }

  function totalFood(s) {
    return s.resources.honey + s.resources.nectar + s.resources.pollen + s.resources.beeswax;
  }

  // Fills hives sequentially (hive 1 fills to cap before hive 2 starts, etc.).
  function distributeAcrossHives(amount, count) {
    const perHive = [];
    let remaining = amount;
    for (let i = 0; i < count; i++) {
      const v = Math.max(0, Math.min(HIVE_CAPACITY_PER_HIVE, remaining));
      perHive.push(v);
      remaining -= v;
    }
    return perHive;
  }

  // Future hook: any hive type's count can grow independently (not wired to UI yet).
  function growHiveCount(type) {
    if (state.hives[type]) state.hives[type].count += 1;
  }

  // ---- derived formulas -------------------------------------------------------------
  function getBuffs(queenLevel) {
    return {
      workerSpeed: 1 + queenLevel * 0.02,   // +2%/level -> "Worker Speed"
      honeyProd: 1 + queenLevel * 0.03,     // +3%/level -> "Honey Production"
      broodGrowth: 1 + queenLevel * 0.02,   // +2%/level -> "Brood Growth"
    };
  }

  function computeHappiness(s) {
    const crowd = s.colony.workers / s.hive.maxWorkers;
    const crowdScore = crowd <= 0.9 ? 100 : Math.max(40, 100 - (crowd - 0.9) * 300);
    const storageCap = getCaps(s).storage;
    const storageScore = totalFood(s) / storageCap > 0.95 ? 80 : 100;
    return Math.round(crowdScore * 0.7 + storageScore * 0.3);
  }

  function splitRoles(workers) {
    const nectarHive = Math.round(workers * HIVE_WORKFORCE_SPLIT.nectarHive);
    const storageHive = Math.round(workers * HIVE_WORKFORCE_SPLIT.storageHive);
    const honeyHivesTotal = Math.max(0, workers - nectarHive - storageHive);
    const processor = Math.round(honeyHivesTotal * HONEY_HIVE_SUBSPLIT.processor);
    const builder = Math.max(0, honeyHivesTotal - processor);
    // storage hive workers: all assigned as Nurses (tend brood), player-adjustable via popup
    const nurse = Math.min(storageHive, Math.max(0, state.nurseAssigned));
    // nectar hive workers: split into individual Nectar Foragers vs continuous Food Foragers
    const nectarForager = state.bees.assigned.nectar;
    // Math.min(nectarHive, Math.max(0, state.colony.nectarForagerAssigned));
    const foodForager = state.bees.assigned.food;
    // Math.max(0, nectarHive - nectarForager);
    return { nectarForager, foodForager, nurse, builder, processor, storageHive, honeyHivesTotal };
  }

  // ---- core tick: advances the whole colony by `dtSeconds` --------------------------
  function tick(dtSeconds) {
    state.lastDtSeconds = dtSeconds; // used by advanceForagerBees, called without dtSeconds directly
    const buffs = getBuffs(state.queen.level);
    state.hives.honey.count = getHoneyHiveCount(state.hive.level);
    syncHoneyHiveInstances(state);
    state.colony.happiness = computeHappiness(state);
    const happinessMult = 0.5 + state.colony.happiness / 200; // 50%..100%
    const roles = splitRoles(state.colony.workers);
    state.lastRoles = roles; // exposed for hive-assignment popups
    const dtMin = dtSeconds / 60;

    // 1) Queen lays eggs, capped by hive room (2x max workers as brood capacity).
    const eggRatePerMin = BASE_EGG_RATE_PER_MIN + EGG_RATE_PER_LEVEL * state.queen.level;
    state.lastEggRate = eggRatePerMin;
    const broodTotal = () => state.colony.brood.eggs + state.colony.brood.larva + state.colony.brood.pupa;
    const broodRoom = state.hive.maxWorkers * 2 - broodTotal() - state.colony.workers;
    if (broodRoom > 0) {
      state.colony.brood.eggProgress += eggRatePerMin * dtMin;
      const newEggs = Math.floor(state.colony.brood.eggProgress);
      if (newEggs > 0) {
        state.colony.brood.eggs += Math.min(newEggs, broodRoom);
        state.colony.brood.eggProgress -= newEggs;
      }
    }

    // 2) Brood stage progression: egg -> larva -> pupa -> worker.
    //    Nurses + queen's broodGrowth buff + colony happiness all speed this up.
    const growthSpeed = buffs.broodGrowth * happinessMult * (1 + roles.nurse * 0.01);
    advanceStage('eggs', 'eggProgress', 'larva', STAGE_DURATION_SEC.egg, growthSpeed, dtSeconds);
    advanceStage('larva', 'larvaProgress', 'pupa', STAGE_DURATION_SEC.larva, growthSpeed, dtSeconds);
    const graduated = advanceStage('pupa', 'pupaProgress', null, STAGE_DURATION_SEC.pupa, growthSpeed, dtSeconds);
    if (graduated > 0) {
      state.colony.workers = Math.min(state.hive.maxWorkers, state.colony.workers + graduated);
    }

    // 3) Nectar Foragers and Food Foragers both do individual round trips (+1 resource per
    //    return). Nectar is capped by the Nectar Hive's own room; Pollen only by shared Storage.
    const caps = getCaps(state);
    let sharedRoom = Math.max(0, caps.storage - totalFood(state));

    const tripSpeed = happinessMult * buffs.workerSpeed;
    advanceForagerBees(state.bees.nectarForagers, roles.nectarForager, tripSpeed, () => {
      // TEMP: only capped by the Nectar Hive's own room, not the shared Storage room —
      // the default starting resources (45/50) left almost no shared room, so nectar
      // looked stuck at ~5 and stopped increasing.
      const nectarRoom = Math.max(0, caps.nectarHive - state.resources.nectar);
      state.resources.nectar += Math.min(1, nectarRoom); // +1 Nectar per completed round trip
    });

    advanceForagerBees(state.bees.foodForagers, roles.foodForager, tripSpeed, () => {
      const gained = Math.min(1, sharedRoom); // +1 Pollen per completed round trip
      state.resources.pollen += gained;
      sharedRoom -= gained;
    }, () => FOOD_FORAGER_PREY[Math.floor(Math.random() * FOOD_FORAGER_PREY.length)]);

    // Honey Hives finish their current one-Nectar conversion before a new worker is sent.
    const honeyCompleted = advanceHoneyHives(dtSeconds);
    state.lastHoneyRate = (honeyCompleted / dtSeconds) * 60;

    // All bees not assigned to nectar, food, or an active Honey Hive fly freely.
    const honeyWorkers = state.hives.honey.instances.filter((hive) => hive.status === 'working').length;
    const freeBeeCount = Math.max(
      0,
      state.colony.total - state.bees.assigned.nectar - state.bees.assigned.food - honeyWorkers,
    );
    advanceFreeBees(state.bees.free, freeBeeCount, dtSeconds);
    dispatchHoneyWorker();

    // 5) Builders secrete Beeswax, then spend it on cosmetic honeycomb-building milestones.
    const wantWax = roles.builder * WAX_PER_BUILDER_PER_MIN * dtMin * happinessMult;
    const waxGained = Math.min(wantWax, sharedRoom);
    state.resources.beeswax += waxGained;
    sharedRoom -= waxGained;

    state.wax.buildProgress += roles.builder * dtMin;
    if (state.wax.buildProgress >= 1 && state.resources.beeswax >= HONEYCOMB_WAX_COST) {
      state.wax.buildProgress = 0;
      state.resources.beeswax -= HONEYCOMB_WAX_COST;
      showToast('toast-build');
    }

    // 6) Nurses occasionally distill Royal Jelly from surplus Pollen.
    for (let i = 0; i < roles.nurse; i++) {
      if (state.resources.pollen >= 5 && Math.random() < JELLY_CHANCE_PER_NURSE_PER_TICK) {
        state.resources.pollen -= 5;
        state.resources.jelly += 1;
      }
    }

    // 7) Auto level-ups when enough resources have been banked.
    tryQueenLevelUp();
    tryHiveLevelUp();

    render();
  }

  // Moves `progress` toward 1 at `speedMult`x, shifting whole units from `fromKey`
  // into `toKey` (or discarding them, when toKey is null, to signal "graduated").
  function advanceStage(fromKey, progressKey, toKey, baseDurationSec, speedMult, dtSeconds) {
    const brood = state.colony.brood;
    if (brood[fromKey] <= 0) return 0;
    brood[progressKey] += (dtSeconds * speedMult) / baseDurationSec;
    const moved = Math.min(brood[fromKey], Math.floor(brood[progressKey]));
    if (moved > 0) {
      brood[progressKey] -= moved;
      brood[fromKey] -= moved;
      if (toKey) brood[toKey] += moved;
    }
    return moved;
  }

  // Drives one forager bee array through its out -> arriving -> depositing -> leaving cycle.
  // `onDeposit` is called exactly once per completed round trip, to award that bee's resource.
  function advanceForagerBees(bees, count, tripSpeed, onDeposit, getCargo) {
    syncForagerBees(bees, count);
    for (const bee of bees) {
      bee.timer -= state.lastDtSeconds * tripSpeed;
      if (bee.timer <= 0) {
        if (bee.phase === 'out') {
          // back from the meadow: fly in from the entrance hole toward the hive
          bee.phase = 'arriving';
          bee.cargo = getCargo ? getCargo() : null;
          bee.total = randomSec(NECTAR_ARRIVE_SEC);
          bee.flightSec = bee.total / tripSpeed; // real wall-clock flight duration, for the CSS transition
        } else if (bee.phase === 'arriving') {
          onDeposit(); // arrived: deposit the resource it carried
          bee.phase = 'depositing';
          bee.total = randomSec(NECTAR_DEPOSIT_SEC);
        } else if (bee.phase === 'depositing') {
          // done depositing: fly back out to the entrance hole, then vanish to search again
          bee.phase = 'leaving';
          bee.cargo = null;
          bee.total = randomSec(NECTAR_LEAVE_SEC);
          bee.flightSec = bee.total / tripSpeed;
        } else {
          bee.phase = 'out';
          bee.total = randomSec(NECTAR_OUT_SEC);
        }
        bee.timer += bee.total;
      }
    }
  }

  function tryQueenLevelUp() {
    const now = Date.now();
    const cost = queenLevelUpCost(state.queen.level);
    if (state.resources.jelly >= cost && now - state.lastQueenLevelUpAt > LEVEL_UP_COOLDOWN_MS) {
      state.resources.jelly -= cost;
      state.queen.level += 1;
      state.lastQueenLevelUpAt = now;
      showLevelUp('Queen Level Up!');
    }
  }

  function tryHiveLevelUp() {
    const now = Date.now();
    const cost = hiveLevelUpCost(state.hive.level);
    if (
      state.resources.honey >= cost.honey &&
      state.resources.beeswax >= cost.beeswax &&
      now - state.lastHiveLevelUpAt > LEVEL_UP_COOLDOWN_MS
    ) {
      state.resources.honey -= cost.honey;
      state.resources.beeswax -= cost.beeswax;
      state.hive.level += 1;
      state.hive.maxWorkers += 5;
      state.lastHiveLevelUpAt = now;
      showLevelUp('Hive Level Up!');
    }
  }

  // ---- DOM rendering ---------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Math.round(n).toLocaleString('id-ID');

  function render() {
    $('res-honey').textContent = fmt(state.resources.honey);
    $('res-nectar').textContent = fmt(state.resources.nectar);
    $('res-pollen').textContent = fmt(state.resources.pollen);
    $('res-beeswax').textContent = fmt(state.resources.beeswax);
    $('res-jelly').textContent = fmt(state.resources.jelly);

    $('stat-queen-level').textContent = state.queen.level;
    $('stat-workers').textContent = state.colony.workers;
    $('stat-workers-max').textContent = state.hive.maxWorkers;
    const brood = state.colony.brood;
    $('stat-brood').textContent = Math.round(brood.eggs + brood.larva + brood.pupa);
    $('stat-hive-level').textContent = state.hive.level;
    $('stat-happiness-fill').style.width = `${state.colony.happiness}%`;
    $('stat-honey-rate').textContent = `+${fmt(state.lastHoneyRate)}`;

    $('queen-level').textContent = state.queen.level;
    $('queen-egg-rate').textContent = `+${state.lastEggRate.toFixed(1)}/min`;
    $('hive-level-badge').textContent = `Lv. ${state.hive.level}`;

    // 3 hive types only: each badge shows hive count + that hive's own fill (x/50).
    const caps = getCaps(state);
    $('hive-role-nectar').textContent =
      `x${state.hives.nectar.count} · ${fmt(state.resources.nectar)}/${caps.nectarHive}`;
    $('hive-role-storage').textContent =
      `x${state.hives.storage.count} · ${fmt(totalFood(state))}/${caps.storage}`;
    const honeyReady = state.hives.honey.instances.filter((h) => h.status === 'full').length;
    $('hive-role-honey').textContent =
      `x${state.hives.honey.count} · ${honeyReady} siap`;

    const buffs = getBuffs(state.queen.level);
    const buffsEl = $('queen-buffs');
    if (buffsEl) {
      buffsEl.innerHTML = `
        <span class="buff">⚡ +${Math.round((buffs.workerSpeed - 1) * 100)}% Speed</span>
        <span class="buff">🍯 +${Math.round((buffs.honeyProd - 1) * 100)}% Honey</span>
        <span class="buff">🐣 +${Math.round((buffs.broodGrowth - 1) * 100)}% Brood</span>
      `;
    }

    // The jar is the player's harvested honey storage, not the colony's food pool.
    const storageUsed = totalFood(state);
    const jarPct = Math.min(100, (state.honeyStorage / caps.storage) * 100);
    $('jar-fill').style.height = `${jarPct}%`;
    $('jar-honey-val').textContent = fmt(state.honeyStorage);
    $('jar-honey-cap').textContent = fmt(caps.storage);

    renderHexGrid(caps, storageUsed);
    renderBeeLayer('nectar-bee-layer', state.bees.nectarForagers, 'Nectar Forager', '🐝');
    renderBeeLayer('food-bee-layer', state.bees.foodForagers, 'Food Forager', '🐝');
    renderFreeBeeLayer(state.bees.free);
  }

  // One hex per real hive instance. Honey Hives cycle through empty, working, and full.
  function renderHexGrid(caps, storageUsed) {
    const grid = $('hex-grid');
    if (!grid) return;

    const nectarPerHive = distributeAcrossHives(state.resources.nectar, state.hives.nectar.count);
    const storagePerHive = distributeAcrossHives(storageUsed, state.hives.storage.count);

    const cells = [
      ...nectarPerHive.map((used, index) => ({ kind: 'fill', type: 'nectar-hive', icon: '🌸', used, cap: HIVE_CAPACITY_PER_HIVE, label: 'Nectar Hive — klik untuk lihat tugas lebah', index })),
      ...storagePerHive.map((used, index) => ({ kind: 'fill', type: 'storage-hive', icon: '🏺', used, cap: HIVE_CAPACITY_PER_HIVE, label: 'Storage Hive — klik untuk lihat tugas lebah', index })),
      ...state.hives.honey.instances.map((h, index) => ({
        kind: 'honey',
        type: 'honey-hive',
        status: h.status,
        incoming: h.incoming,
        index,
        icon: h.status === 'full' ? '🍯' : h.status === 'working' ? '🐝' : '○',
        label: h.status === 'full' ? 'Full — klik untuk simpan 1 Honey ke toples!' : h.status === 'working' ? 'Lebah sedang mengubah Nectar menjadi Honey...' : h.incoming ? 'Lebah sedang menuju Hive...' : 'Honey Hive kosong',
      })),
    ];

    const rows = [];
    for (let i = 0; i < cells.length; i += 3) rows.push(cells.slice(i, i + 3));

    grid.innerHTML = rows.map((row, rowIndex) => `
      <div class="hex-row${rowIndex % 2 === 0 ? ' offset' : ''}">
        ${row.map((cell) => {
          if (cell.kind === 'honey') {
            return `
              <div class="hex hex-hive ${cell.type} ${cell.status}${cell.incoming ? ' incoming' : ''}${cell.status === 'full' ? ' full ready-collect' : ''}" data-honey-index="${cell.index}" title="${cell.label}">
                <span>${cell.icon}</span>
                <span class="hex-fill-label">${cell.status === 'full' ? 'FULL · +1' : cell.status === 'working' ? 'MENGOLAH' : cell.incoming ? 'DATANG...' : 'KOSONG'}</span>
              </div>`;
          }
          const pct = Math.round((cell.used / cell.cap) * 100);
          const indexAttr = cell.type === 'nectar-hive' ? ` data-nectar-index="${cell.index}"` : '';
          return `
            <div class="hex hex-hive ${cell.type}${pct >= 100 ? ' full' : ''}" style="--fill:${pct}%"${indexAttr} title="${cell.label} — ${fmt(cell.used)}/${cell.cap}">
              <span>${cell.icon}</span>
              <span class="hex-fill-label">${fmt(cell.used)}/${cell.cap}</span>
            </div>`;
        }).join('')}
      </div>`).join('');
  }

  // Bees fly out of the fixed hive entrance hole, vanish while searching the meadow (phase
  // 'out'), then fly back to the real Nectar Hive hex to deposit (phase 'depositing') before
  // leaving again. DOM elements are reused every tick so the CSS transition has a "from"
  // position to glide from, giving smooth flight instead of a choppy jump-cut.
  const FALLBACK_SPOT = { left: 6, top: 94 };

  // Measures an element's center, as a % of .honeycomb-wrap, so bees fly to where it really is.
  function getSpotOf(selector) {
    const wrap = document.querySelector('.honeycomb-wrap');
    const el = document.querySelector(selector);
    if (!wrap || !el) return FALLBACK_SPOT;
    const wrapRect = wrap.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    return {
      left: ((elRect.left + elRect.width / 2 - wrapRect.left) / wrapRect.width) * 100,
      top: ((elRect.top + elRect.height / 2 - wrapRect.top) / wrapRect.height) * 100,
    };
  }

  // Renders one forager bee array into its DOM layer. Both Nectar and Food Foragers work out
  // of the same Nectar Hive building, so they share the same entrance hole + hive target spot.
  function renderBeeLayer(layerId, bees, label, icon) {
    const layer = $(layerId);
    if (!layer) return;
    const entranceSpot = getSpotOf('.hive-entrance-hole');
    let hiveSpot ="";
    if(label=='Nectar Forager')
        hiveSpot = getSpotOf('#hex-grid .hex-hive.nectar-hive');
    if(label=='Food Forager')
        hiveSpot = getSpotOf('#hex-grid .hex-hive.storage-hive');

    while (layer.children.length < bees.length) {
      const el = document.createElement('span');
      el.className = 'nectar-bee';
      el.innerHTML = `
        <span class="bee-3d forager-bee ${label === 'Food Forager' ? 'food-bee' : 'nectar-bee-model'}" aria-hidden="true">
          <span class="bee-wing wing-left"></span><span class="bee-wing wing-right"></span>
          <span class="bee-body"><i></i><i></i><i></i></span>
          <span class="bee-head"><b></b><b></b></span>
          <span class="bee-cargo"></span>
          <span class="bee-stinger"></span>
        </span>`;
      layer.appendChild(el);
    }
    while (layer.children.length > bees.length) layer.removeChild(layer.lastChild);

    bees.forEach((bee, index) => {
      const el = layer.children[index];
      el.classList.toggle('carrying', bee.phase === 'arriving' || bee.phase === 'depositing');
      el.className = `nectar-bee phase-${bee.phase}${el.classList.contains('carrying') ? ' carrying' : ''}`;
      const cargo = el.querySelector('.bee-cargo');
      if (cargo && label === 'Food Forager') cargo.textContent = bee.cargo || '';

      if (bee.phase === 'out') {
        // gone searching the meadow: snap straight to the entrance hole, then fade out there
        // (state already switched phase before this frame, so "leaving" never finishes at 100%)
        el.style.left = `${entranceSpot.left}%`;
        el.style.top = `${entranceSpot.top}%`;
        el.style.opacity = '0';
      } else if (bee.phase === 'arriving') {
        // target this bee's destination hive directly; transition duration matches the real
        // flight time so the bee visually lands exactly when depositing (and the +1) starts.
        const flightSec = Math.max(0.05, bee.flightSec || 1);
        el.style.transition = `left ${flightSec}s linear, top ${flightSec}s linear, opacity 0.3s ease`;
        el.style.opacity = '1';
        el.style.left = `${hiveSpot.left}%`;
        el.style.top = `${hiveSpot.top}%`;
        el.style.transform = '';
      } else if (bee.phase === 'depositing') {
        el.style.transition = 'left 0.2s ease, top 0.2s ease, opacity 0.3s ease';
        el.style.opacity = '1';
        el.style.left = `${hiveSpot.left}%`;
        el.style.top = `${hiveSpot.top}%`;
        el.style.transform = '';
      } else if (bee.phase === 'leaving') {
        const flightSec = Math.max(0.05, bee.flightSec || 1);
        el.style.transition = `left ${flightSec}s linear, top ${flightSec}s linear, transform 0.3s ease`;
        el.style.opacity = '1';
        el.style.left = `${entranceSpot.left}%`;
        el.style.top = `${entranceSpot.top}%`;
        el.style.transform = 'scaleX(-1)';
      }
      el.title = `${label} #${index + 1} — ${bee.phase}`;
    });
  }

  function renderFreeBeeLayer(bees) {
    const layer = $('free-bee-layer');
    if (!layer) return;
    while (layer.children.length < bees.length) {
      const el = document.createElement('span');
      el.className = 'free-bee';
      el.innerHTML = `
        <span class="bee-3d free-roaming-bee" aria-hidden="true">
          <span class="bee-wing wing-left"></span><span class="bee-wing wing-right"></span>
          <span class="bee-body"><i></i><i></i><i></i></span>
          <span class="bee-head"><b></b><b></b></span>
          <span class="bee-stinger"></span>
        </span>`;
      layer.appendChild(el);
    }
    while (layer.children.length > bees.length) layer.removeChild(layer.lastChild);

    bees.forEach((bee, index) => {
      const el = layer.children[index];
      el.classList.toggle('handoff', Boolean(bee.handoff));
      el.style.transition = `left ${bee.flightSec}s cubic-bezier(.36,.01,.55,1), top ${bee.flightSec}s cubic-bezier(.36,.01,.55,1)`;
      el.style.left = `${bee.left}%`;
      el.style.top = `${bee.top}%`;
      el.style.setProperty('--bee-facing', bee.facing);
      el.title = `Lebah bebas #${index + 1}`;
    });
  }

  function showToast(id) {
    const el = $(id);
    if (!el) return;
    el.style.animation = 'none';
    // restart the CSS animation
    void el.offsetWidth;
    el.style.animation = '';
  }

  function showLevelUp(text) {
    const fx = $('levelup-fx');
    const label = $('levelup-text');
    if (!fx || !label) return;
    label.textContent = text;
    fx.classList.remove('show');
    void fx.offsetWidth;
    fx.classList.add('show');
  }

  // ---- Sell Honey: bank the jar contents, then empty the jar ------------------------
  function sellHoney() {
    state.bank.honeyCollected += state.honeyStorage;
    state.honeyStorage = 0;
    render();
  }

  // ---- Harvest a full Honey Hive: transfer exactly 1 Honey to the jar. --------------
  function collectHoneyHive(index) {
    const inst = state.hives.honey.instances[index];
    if (!inst || inst.status !== 'full') return;
    const caps = getCaps(state);
    const room = Math.max(0, caps.storage - state.honeyStorage);
    if (room < 1) return;
    state.honeyStorage += 1;
    inst.status = 'empty';
    inst.timer = 0;
    render();
  }

  // ---- Hive assignment popups: shown when a Nectar/Storage Hive hex is clicked --------
  function showNectarAssignPopup() {
    const popup = $('bee-popup');
    if (!popup) return;
    $('bee-popup-title').textContent = '🌸 Nectar Hive';
    renderNectarStepperBody();
    $('bee-popup-note').innerHTML = 'Lebah pencari nektar keluar sarang, kembali membawa <b>+1 Nectar</b>, lalu pergi lagi.';
    popup.classList.add('show');
  }

  // Redrawn on open + after every +/- click so the count and button state stay in sync.
  function renderNectarStepperBody() {
    const body = $('bee-popup-body');
    if (!body) return;
    body.innerHTML = `
      <div class="bee-popup-row">
        <span>Lebah pencari nektar</span>
        <div class="stepper">
          <button class="stepper-btn" id="nectar-assign-minus" ${state.colony.nectarForagerAssigned <= 0 ? 'disabled' : ''}>−</button>
          <b id="nectar-assign-count">${state.colony.nectarForagerAssigned}</b>
          <button class="stepper-btn" id="nectar-assign-plus">+</button>
        </div>
      </div>`;
    const minus = $('nectar-assign-minus');
    const plus = $('nectar-assign-plus');
    if (minus) minus.addEventListener('click', () => adjustNectarForagerAssigned(-1));
    if (plus) plus.addEventListener('click', () => adjustNectarForagerAssigned(1));
  }

  // Capped at the Nectar Hive's total workforce (Nectar Foragers + Food Foragers combined).
  function adjustNectarForagerAssigned(delta) {
    // const roles = state.lastRoles || { nectarForager: 0, foodForager: 0 };
    const maxAssignable = state.colony.total
    state.colony.nectarForagerAssigned = Math.max(0, Math.min(maxAssignable, state.colony.nectarForagerAssigned + delta));
    renderNectarStepperBody();
  }

  function showStorageAssignPopup() {
    const popup = $('bee-popup');
    if (!popup) return;
    $('bee-popup-title').textContent = '🏺 Storage Hive';
    // renderNurseStepperBody();

    renderFoodStepperBody();
    $('bee-popup-note').innerHTML = 'Nurse merawat Brood, mempercepat pertumbuhannya, & membuat Royal Jelly dari Pollen.';
    popup.classList.add('show');
  }
  

  // Redrawn on open + after every +/- click so the count and button state stay in sync.
  function renderFoodStepperBody() {
    const body = $('bee-popup-body');
    if (!body) return;
    body.innerHTML = `
      <div class="bee-popup-row"><div class="bee-popup-row">
            <span>Lebah pencari makanan</span>

            <button class="stepper-btn" id="food-assign-minus" ${state.colony.foodForagerAssigned <= 0 ? 'disabled' : ''}>−</button>
            <b id="nectar-assign-count">${state.colony.foodForagerAssigned}</b>
            <button class="stepper-btn" id="food-assign-plus">+</button>
        </div>
      </div>`;
    const minus = $('food-assign-minus');
    const plus = $('food-assign-plus');
    if (minus) minus.addEventListener('click', () => adjustFoodForagerAssigned(-1));
    if (plus) plus.addEventListener('click', () => adjustFoodForagerAssigned(1));
  }
    // Capped at the Nectar Hive's total workforce (Nectar Foragers + Food Foragers combined).
  function adjustFoodForagerAssigned(delta) {
    // const roles = state.lastRoles || { nectarForager: 0, foodForager: 0 };
    const maxAssignable = state.colony.total
    state.colony.foodForagerAssigned = Math.max(0, Math.min(maxAssignable, state.colony.foodForagerAssigned + delta));
    renderFoodStepperBody();
  }

  // Redrawn on open + after every +/- click so the count and button state stay in sync.
  function renderNurseStepperBody() {
    const body = $('bee-popup-body');
    if (!body) return;
    body.innerHTML = `
      <div class="bee-popup-row"><div class="bee-popup-row">
        <span>Nurse (rawat brood)</span>
        <div class="stepper">
      <button class="stepper-btn" id="nurse-assign-minus" ${state.nurseAssigned <= 0 ? 'disabled' : ''}>−</button>
      <b id="nurse-assign-count">${state.nurseAssigned}</b>
      <button class="stepper-btn" id="nurse-assign-plus">+</button>
    </div>`
        
    const minus = $('nurse-assign-minus');
    const plus = $('nurse-assign-plus');
    if (minus) minus.addEventListener('click', () => adjustNurseAssigned(-1));
    if (plus) plus.addEventListener('click', () => adjustNurseAssigned(1));
  }

  // Capped at the Storage Hive's total workforce.
  function adjustNurseAssigned(delta) {
    const roles = state.lastRoles || { storageHive: 0 };
    state.nurseAssigned = Math.max(0, Math.min(roles.storageHive, state.nurseAssigned + delta));
    renderNurseStepperBody();
  }

  function hideAssignPopup() {
    const popup = $('bee-popup');
    if (popup) popup.classList.remove('show');
  }

  // ---- boot --------------------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', () => {
    render();
    const collectBtn = $('collect-btn');
    if (collectBtn) collectBtn.addEventListener('click', sellHoney);
    const hexGrid = $('hex-grid');
    if (hexGrid) {
      hexGrid.addEventListener('click', (e) => {
        if (e.target.closest('.honey-hive.full')) {
          collectHoneyHive(Number(e.target.closest('.honey-hive.full').dataset.honeyIndex));
          return;
        }
        if (e.target.closest('.nectar-hive')) {
          showNectarAssignPopup();
          return;
        }
        if (e.target.closest('.storage-hive')) {
          showStorageAssignPopup();
        }
      });
    }
    const popupClose = $('bee-popup-close');
    if (popupClose) popupClose.addEventListener('click', hideAssignPopup);
    const popupOverlay = $('bee-popup');
    if (popupOverlay) popupOverlay.addEventListener('click', (e) => {
      if (e.target === popupOverlay) hideAssignPopup();
    });
    setInterval(() => tick(TICK_MS / 1000), TICK_MS);
  });

  // exposed for future UI hooks (e.g. a "build new Storage Hive" button)
  window.beeColonyGrowHive = growHiveCount;
})();
