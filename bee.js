// Bee model: identity and mutable activity belong to each individual bee.
(() => {
let nextBeeId = 1;

const BEE_NAMES = [
  'Aster', 'Bima', 'Cleo', 'Dara', 'Ember', 'Fajar',
  'Gita', 'Hana', 'Indra', 'Juno', 'Kala', 'Luna',
];

function createBee(role, activity, extra = {}) {
  const id = nextBeeId++;
  return {
    id,
    name: `${BEE_NAMES[(id - 1) % BEE_NAMES.length]}-${id}`,
    role,
    activity,
    targetHiveIndex: null,
    cargo: null,
    ...extra,
  };
}

window.BeeModel = { createBee };
})();
