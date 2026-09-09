// Hive model helpers. A Honey Hive owns only its cell state; a bee owns its activity.
(() => {
function getHoneyHiveCount(hiveLevel) {
  return Math.max(1, hiveLevel - 1);
}

function createHoneyHive() {
  return { status: 'empty', incoming: false, worker: null };
}

function distributeAcrossHives(amount, count, capacityPerHive) {
  const perHive = [];
  let remaining = amount;
  for (let index = 0; index < count; index += 1) {
    const used = Math.max(0, Math.min(capacityPerHive, remaining));
    perHive.push(used);
    remaining -= used;
  }
  return perHive;
}

window.HiveModel = { createHoneyHive, distributeAcrossHives, getHoneyHiveCount };
})();
