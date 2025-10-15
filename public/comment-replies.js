(function () {
  const form = document.querySelector('[data-comment-preview-form]');
  if (!form) {
    return;
  }

  const parentInput = form.querySelector('[data-comment-parent-input]');
  const replyBanner = form.querySelector('[data-reply-target]');
  const replyLabel = replyBanner ? replyBanner.querySelector('[data-reply-target-label]') : null;
  const clearButton = replyBanner ? replyBanner.querySelector('[data-clear-reply]') : null;
  const textarea = form.querySelector('textarea[name="body"]');

  const escapeSelector = (value) => {
    if (window.CSS && typeof window.CSS.escape === 'function') {
      return window.CSS.escape(value);
    }
    return String(value).replace(/([\0-\x1f\x7f]|[!"#$%&'()*+,./:;<=>?@\[\]^`{|}~])/g, '\\$1');
  };

  let highlightedComment = null;

  const clearHighlight = () => {
    if (highlightedComment) {
      highlightedComment.classList.remove('is-reply-target');
      highlightedComment = null;
    }
  };

  const setReplyTarget = (commentId, { focus = true } = {}) => {
    if (!parentInput) {
      return;
    }
    const trimmedId = (commentId || '').trim();
    if (!trimmedId) {
      parentInput.value = '';
      if (replyBanner) {
        replyBanner.hidden = true;
      }
      clearHighlight();
      return;
    }
    const selector = `.comment[data-comment-id="${escapeSelector(trimmedId)}"]`;
    const commentElement = document.querySelector(selector);
    if (!commentElement) {
      parentInput.value = '';
      if (replyBanner) {
        replyBanner.hidden = true;
      }
      clearHighlight();
      return;
    }
    parentInput.value = trimmedId;
    const authorName =
      commentElement.getAttribute('data-author-name') ||
      commentElement.querySelector('.comment-author')?.textContent?.trim() ||
      'Anonyme';
    if (replyBanner && replyLabel) {
      replyLabel.textContent = authorName;
      replyBanner.hidden = false;
    }
    if (highlightedComment !== commentElement) {
      clearHighlight();
      commentElement.classList.add('is-reply-target');
      highlightedComment = commentElement;
    }
    if (focus && textarea) {
      textarea.focus({ preventScroll: false });
    }
  };

  const clearReplyTarget = (options = {}) => {
    const { focus = false } = options;
    if (parentInput) {
      parentInput.value = '';
    }
    if (replyBanner) {
      replyBanner.hidden = true;
    }
    clearHighlight();
    if (focus && textarea) {
      textarea.focus({ preventScroll: false });
    }
  };

  document.addEventListener('click', (event) => {
    const target = event.target.closest('.comment-reply-button');
    if (!target) {
      return;
    }
    const commentId = target.getAttribute('data-reply-to');
    if (!commentId) {
      return;
    }
    setReplyTarget(commentId, { focus: true });
  });

  if (clearButton) {
    clearButton.addEventListener('click', (event) => {
      event.preventDefault();
      clearReplyTarget({ focus: true });
    });
  }

  const initialParent = form.getAttribute('data-initial-parent') || '';
  if (initialParent) {
    setReplyTarget(initialParent, { focus: false });
  }
})();
