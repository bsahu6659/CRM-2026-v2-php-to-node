/**
 * Growvanta CRM - public site behaviour.
 *
 * The three marketing pages are plain HTML and stay readable with this file
 * missing, blocked or failed. Everything here is decoration, so it is added
 * rather than assumed: the `js-reveal` class that hides content is set BY this
 * script, which means a browser that never runs it shows the page in full
 * instead of a column of invisible sections.
 *
 * Why a scroll sweep rather than IntersectionObserver
 * ---------------------------------------------------
 * IntersectionObserver fires when an element CROSSES a threshold. Scroll far
 * enough in one movement - a flick on a phone, a jump to an anchor, End - and
 * an element can go from below the fold to above it without ever intersecting.
 * No crossing, no callback, and that element stays at opacity 0 for as long as
 * the reader is on the page. It was reproducible here: two fast scrolls left 22
 * of 35 blocks permanently invisible.
 *
 * A rAF-throttled sweep cannot have that gap, because it asks "is this at or
 * above the fold NOW" rather than "did it just cross". Revealed elements leave
 * the list, so the work shrinks to nothing and the listeners detach.
 */
(function () {
  'use strict';

  var lessMotion = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (lessMotion) return;

  var targets = document.querySelectorAll(
    '.band .eyebrow, .band > .wrap > h2, .band > .wrap > .lede, ' +
    '.card, .note, .table-scroll, .band .hero__cta'
  );
  if (!targets.length) return;

  document.documentElement.classList.add('js-reveal');

  var pending = [];
  Array.prototype.forEach.call(targets, function (el) {
    el.classList.add('reveal');
    pending.push(el);
  });

  // Cards in one row arrive a beat apart rather than together. The stagger
  // restarts per grid and caps at six, so a card low on the page is never left
  // waiting on the position of cards above it.
  Array.prototype.forEach.call(document.querySelectorAll('.grid'), function (grid) {
    Array.prototype.forEach.call(grid.children, function (child, i) {
      child.style.setProperty('--reveal-delay', Math.min(i, 5) * 70 + 'ms');
    });
  });

  /**
   * Once an element has finished arriving, take the reveal classes off it.
   *
   * Not tidiness - correctness. `.js-reveal .reveal.is-in` sets
   * `transform: none` at three classes of specificity, which outranks
   * `.card:hover` at two. Leave the classes on and every card's hover lift is
   * silently cancelled for the rest of the session: the shadow appears, the
   * card does not move, and nothing in the CSS looks wrong.
   */
  function settle(el) {
    var delay = parseFloat(el.style.getPropertyValue('--reveal-delay')) || 0;
    window.setTimeout(function () {
      el.classList.remove('reveal', 'is-in');
      el.style.removeProperty('--reveal-delay');
    }, delay + 700); // the .55s transition, plus room for a slow frame
  }

  var ticking = false;

  function sweep() {
    ticking = false;
    // Slightly inside the fold, so the movement has finished by the time the
    // reader's eye arrives.
    var fold = window.innerHeight * 0.92;
    for (var i = pending.length - 1; i >= 0; i--) {
      if (pending[i].getBoundingClientRect().top < fold) {
        pending[i].classList.add('is-in');
        settle(pending[i]);
        pending.splice(i, 1);
      }
    }
    if (!pending.length) {
      window.removeEventListener('scroll', request);
      window.removeEventListener('resize', request);
    }
  }

  function request() {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(sweep);
  }

  window.addEventListener('scroll', request, { passive: true });
  window.addEventListener('resize', request);

  sweep();                   // whatever is already on screen at load
  window.addEventListener('load', request);  // and again once images have sized
}());
