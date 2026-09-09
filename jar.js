// Jar model: harvested honey stays separate from colony resources.
(() => {
function createHoneyJar() {
  return { honey: 0 };
}

function addHoneyToJar(jar, capacity, amount = 1) {
  if (jar.honey + amount > capacity) return false;
  jar.honey += amount;
  return true;
}

function sellHoneyJar(jar) {
  const sold = jar.honey;
  jar.honey = 0;
  return sold;
}

window.JarModel = { addHoneyToJar, createHoneyJar, sellHoneyJar };
})();
