// Slide switching for the deck variants: arrows, space, PageUp/PageDown, Home/End, F for full screen.
// The slide number lives in the URL hash (#3), so a reload keeps the place.
const slides = [...document.querySelectorAll(".slide")];
let current = 0;

function fit() {
  const scale = Math.min(innerWidth / 1920, innerHeight / 1080);
  document.documentElement.style.setProperty("--scale", String(scale));
}

function show(index) {
  current = Math.max(0, Math.min(slides.length - 1, index));
  slides.forEach((slide, i) => slide.classList.toggle("on", i === current));
  history.replaceState(null, "", `#${current + 1}`);
}

slides.forEach((slide, i) => {
  const no = document.createElement("span");
  no.className = "page-no";
  no.textContent = String(i + 1);
  slide.append(no);
});

addEventListener("keydown", event => {
  if (["ArrowRight", "ArrowDown", "PageDown", " "].includes(event.key)) show(current + 1);
  else if (["ArrowLeft", "ArrowUp", "PageUp"].includes(event.key)) show(current - 1);
  else if (event.key === "Home") show(0);
  else if (event.key === "End") show(slides.length - 1);
  else if (event.key === "f" || event.key === "F" || event.key === "а" || event.key === "А") {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  } else return;
  event.preventDefault();
});
addEventListener("click", event => show(current + (event.clientX > innerWidth / 3 ? 1 : -1)));
addEventListener("resize", fit);

fit();
show(Number(location.hash.slice(1)) - 1 || 0);
