document.body.addEventListener('touchmove', function(event) {
  event.preventDefault();
}, {
  passive: false,
  useCapture: false
});

window.onresize = function() {
  $(document.body).width(window.innerWidth).height(window.innerHeight);
}

$(function() {
  window.onresize();
});
