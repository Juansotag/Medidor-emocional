// Construye el medidor emocional (10 x 10) en el estilo del dibujo de referencia.
// x: agrado (-5 a -1 no agradable, 1 a 5 agradable)
// y: energía (5 a 1 alta, -1 a -5 baja)

const QUAD_LABELS = {
  rojo: 'furia · pánico · miedo · ansiedad · estrés · irritación',
  amarillo: 'amor · placer · euforia · sorpresa · optimismo · alegría',
  azul: 'soledad · tristeza · asco · depresión · confusión',
  verde: 'calma · alivio · gratitud · confianza · serenidad',
};
const QUAD_NAMES = {
  rojo: 'Alta energía y no agradable',
  amarillo: 'Alta energía y agradable',
  azul: 'Baja energía y no agradable',
  verde: 'Baja energía y agradable',
};
const QUAD_INK = { rojo: '#b8483b', amarillo: '#a67c00', azul: '#3f6fa8', verde: '#4f8a22' };

const AXIS_X = [-5, -4, -3, -2, -1, 1, 2, 3, 4, 5];
const AXIS_Y = [5, 4, 3, 2, 1, -1, -2, -3, -4, -5];

function quadrantOf(x, y) {
  if (y > 0) return x < 0 ? 'rojo' : 'amarillo';
  return x < 0 ? 'azul' : 'verde';
}

function buildMeter(container, { interactive = false, onPick } = {}) {
  container.classList.add('meter');
  container.innerHTML = `
    <div class="y-axis"><span>baja energía</span><span class="arrow">⟷</span><span>alta energía</span></div>
    <div class="board">
      <div class="cells"></div>
      <div class="labels">
        <div>${QUAD_LABELS.rojo}</div><div>${QUAD_LABELS.amarillo}</div>
        <div>${QUAD_LABELS.azul}</div><div>${QUAD_LABELS.verde}</div>
      </div>
    </div>
    <div class="x-axis"><span>no agradable</span><span class="arrow">⟷</span><span>agradable</span></div>`;

  const cellsEl = container.querySelector('.cells');
  const cells = new Map();
  AXIS_Y.forEach((y, r) => {
    AXIS_X.forEach((x, c) => {
      const el = document.createElement(interactive ? 'button' : 'div');
      if (interactive) el.type = 'button';
      const q = quadrantOf(x, y);
      el.className = `cell ${q} c${c + 1} r${r + 1}`;
      el.dataset.x = x; el.dataset.y = y; el.dataset.q = q;
      el.setAttribute('aria-label', `${QUAD_NAMES[q]}, agrado ${x}, energía ${y}`);
      if (interactive) {
        el.addEventListener('click', () => {
          cellsEl.querySelectorAll('.picked').forEach(p => p.classList.remove('picked'));
          el.classList.add('picked');
          cellsEl.classList.add('has-pick');
          onPick && onPick({ x, y, q });
        });
      }
      cellsEl.appendChild(el);
      cells.set(`${x},${y}`, el);
    });
  });

  return {
    cells,
    clear() {
      cellsEl.querySelectorAll('.picked').forEach(p => p.classList.remove('picked'));
      cellsEl.classList.remove('has-pick');
    },
  };
}
