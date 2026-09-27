// loading screen and title card only (quick visual check at the harness size)
export default async function (g) {
  await g.delay(2000);
  await g.evalJs(`(() => { const l = document.getElementById('loading'); l.style.transition = 'none'; l.classList.remove('done'); document.querySelector('.loading-fill').style.width = '64%'; document.querySelector('.loading-label').textContent = 'Loading water'; })()`);
  await g.delay(250);
  await g.shot(`loading-${g.W}`);
  await g.evalJs(`document.getElementById('loading').classList.add('done')`);
  await g.delay(300);
  await g.shot(`title-${g.W}`);
  console.log('errors', g.errors.length);
}
