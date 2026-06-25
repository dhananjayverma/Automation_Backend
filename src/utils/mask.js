function maskPan(pan) {
  if (!pan || pan.length < 6) {
    return "**********";
  }

  return `${pan.slice(0, 2)}******${pan.slice(-2)}`;
}

module.exports = { maskPan };
