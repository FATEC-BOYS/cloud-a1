const btn = document.getElementById('btn');
const out = document.getElementById('out');

btn.addEventListener('click', () => {
  const now = new Date();
  out.textContent = `Clicou às ${now.toLocaleString()}`;
});

// exemplo de “estado” simples
let count = 0;
setInterval(() => {
  count++;
  document.title = `Contador: ${count}`;
}, 1000);
