/* Claude (claude.ai) adapter.
   2026-09-27: In a signed-in new chat the visible editor was
   div.tiptap.ProseMirror[contenteditable="true"][role="textbox"]
   with data-testid="chat-input" and without a form.
   After the extension was reloaded, a synthetic email was masked and
   unmasked; selected synthetic text was also masked in the live editor
   without sending it. The button sat above
   the editor and did not overlap the send control. */
(function () {
  "use strict";

  window.MaskelemeInjector.start({
    id: "claude",

    findComposer: function () {
      var visible = window.MaskelemeInjector.gorunurMu;
      var chatInput = document.querySelector('[data-testid="chat-input"][contenteditable="true"]');
      if (visible(chatInput)) return chatInput;
      var candidates = document.querySelectorAll(
        'div.ProseMirror[contenteditable="true"], [data-placeholder][contenteditable="true"], [role="textbox"][contenteditable="true"]'
      );
      var fallback = null;
      for (var i = 0; i < candidates.length; i++) {
        var el = candidates[i];
        if (!visible(el)) continue;
        if (el.closest("form") || el.closest('[class*="composer"]')) return el;
        if (!fallback && el.matches('div.ProseMirror[contenteditable="true"]')) fallback = el;
      }
      return fallback;
    },

    findToolbar: function (composerEl) {
      return composerEl.closest("form") || composerEl.closest('[class*="composer"]') || composerEl;
    }
  });
})();
