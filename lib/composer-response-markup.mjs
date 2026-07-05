/**
 * Convert Cursor composer bubble data into markdown suitable for response.txt.
 * Includes prose, lists, AskQuestion forms, and todo checkboxes shown in the agent tab.
 */

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function parseJsonObject(value) {
  if (!value) {
    return null;
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return /** @type {Record<string, unknown>} */ (value);
  }
  if (typeof value !== 'string') {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? /** @type {Record<string, unknown>} */ (parsed)
      : null;
  } catch {
    return null;
  }
}

/**
 * @param {unknown} value
 * @returns {unknown[] | null}
 */
function parseJsonArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value !== 'string') {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * @param {unknown} node
 * @returns {string}
 */
function richTextNodeToMarkdown(node) {
  if (!node || typeof node !== 'object') {
    return '';
  }

  const record = /** @type {Record<string, unknown>} */ (node);
  const type = record.type;

  if (type === 'text' && typeof record.text === 'string') {
    return record.text;
  }

  if (type === 'linebreak') {
    return '\n';
  }

  if (type === 'mention') {
    if (typeof record.text === 'string' && record.text.trim()) {
      return record.text;
    }
    if (typeof record.mentionName === 'string' && record.mentionName.trim()) {
      return `@${record.mentionName}`;
    }
    return '';
  }

  if (type === 'link' && typeof record.url === 'string') {
    const label =
      typeof record.text === 'string' && record.text.trim() ? record.text : record.url;
    return `[${label}](${record.url})`;
  }

  if (type === 'code') {
    const text = typeof record.text === 'string' ? record.text : '';
    return `\`${text}\``;
  }

  if (type === 'image') {
    const alt = typeof record.altText === 'string' ? record.altText : 'image';
    const src = typeof record.src === 'string' ? record.src : '';
    return src ? `![${alt}](${src})` : '';
  }

  const children = record.children;
  if (!Array.isArray(children)) {
    return '';
  }

  const childText = children.map(child => richTextNodeToMarkdown(child)).join('');

  if (type === 'paragraph' || type === 'root') {
    return `${childText}\n\n`;
  }

  if (type === 'heading') {
    const tag = typeof record.tag === 'string' ? record.tag : 'h3';
    const level = Number.parseInt(tag.replace('h', ''), 10);
    const hashes = '#'.repeat(Number.isFinite(level) && level > 0 ? level : 3);
    return `${hashes} ${childText.trim()}\n\n`;
  }

  if (type === 'list') {
    const listType = record.listType === 'number' ? 'number' : 'bullet';
    const items = children
      .map((child, index) => {
        const itemText = richTextNodeToMarkdown(child).trim();
        if (!itemText) {
          return '';
        }
        const prefix = listType === 'number' ? `${index + 1}. ` : '- ';
        return `${prefix}${itemText}`;
      })
      .filter(Boolean);
    return items.length > 0 ? `${items.join('\n')}\n\n` : '';
  }

  if (type === 'listitem') {
    return childText;
  }

  if (type === 'quote') {
    const quoted = childText
      .trim()
      .split('\n')
      .map(line => `> ${line}`)
      .join('\n');
    return `${quoted}\n\n`;
  }

  return childText;
}

/**
 * @param {unknown} richText
 * @returns {string}
 */
export function richTextToMarkdown(richText) {
  if (!richText) {
    return '';
  }

  let parsed = richText;
  if (typeof richText === 'string') {
    try {
      parsed = JSON.parse(richText);
    } catch {
      return '';
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    return '';
  }

  const root =
    'root' in /** @type {Record<string, unknown>} */ (parsed)
      ? /** @type {Record<string, unknown>} */ (parsed).root
      : parsed;
  return richTextNodeToMarkdown(root).replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * @param {unknown} todos
 * @param {{ heading?: string }} [options]
 * @returns {string}
 */
export function todosToMarkdown(todos, options = {}) {
  const items = parseJsonArray(todos);
  if (!items || items.length === 0) {
    return '';
  }

  const lines = [];
  if (options.heading) {
    lines.push(options.heading, '');
  }

  for (const item of items) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const record = /** @type {Record<string, unknown>} */ (item);
    const content = typeof record.content === 'string' ? record.content.trim() : '';
    if (!content) {
      continue;
    }
    const status = typeof record.status === 'string' ? record.status : 'pending';
    if (status === 'completed') {
      lines.push(`- [x] ${content}`);
    } else if (status === 'in_progress') {
      lines.push(`- [ ] ${content} *(in progress)*`);
    } else if (status === 'cancelled') {
      lines.push(`- [ ] ~~${content}~~ *(cancelled)*`);
    } else {
      lines.push(`- [ ] ${content}`);
    }
  }

  return lines.length > (options.heading ? 2 : 0) ? lines.join('\n').trim() : '';
}

/**
 * @param {Record<string, unknown>} toolFormerData
 * @returns {string}
 */
function askQuestionToMarkdown(toolFormerData) {
  const params = parseJsonObject(toolFormerData.params);
  if (!params) {
    return '';
  }

  const title = typeof params.title === 'string' ? params.title.trim() : '';
  const questions = parseJsonArray(params.questions);
  if (!questions || questions.length === 0) {
    return '';
  }

  /** @type {Map<string, Set<string>>} */
  const selectedByQuestionId = new Map();

  const result = parseJsonObject(toolFormerData.result);
  const answers = parseJsonArray(result?.answers);
  if (answers) {
    for (const answer of answers) {
      if (!answer || typeof answer !== 'object') {
        continue;
      }
      const record = /** @type {Record<string, unknown>} */ (answer);
      const questionId = typeof record.questionId === 'string' ? record.questionId : '';
      if (!questionId) {
        continue;
      }
      const selected = new Set();
      const optionIds = parseJsonArray(record.selectedOptionIds);
      if (optionIds) {
        for (const optionId of optionIds) {
          if (typeof optionId === 'string' && optionId) {
            selected.add(optionId);
          }
        }
      }
      const freeform = typeof record.freeformText === 'string' ? record.freeformText.trim() : '';
      if (freeform) {
        selected.add(`__freeform__:${freeform}`);
      }
      selectedByQuestionId.set(questionId, selected);
    }
  }

  const additionalData = parseJsonObject(toolFormerData.additionalData);
  const currentSelections = additionalData?.currentSelections;
  if (currentSelections && typeof currentSelections === 'object' && !Array.isArray(currentSelections)) {
    for (const [questionId, selection] of Object.entries(
      /** @type {Record<string, unknown>} */ (currentSelections),
    )) {
      if (!questionId || selectedByQuestionId.has(questionId)) {
        continue;
      }
      const selected = new Set();
      if (typeof selection === 'string' && selection) {
        selected.add(selection);
      } else if (Array.isArray(selection)) {
        for (const optionId of selection) {
          if (typeof optionId === 'string' && optionId) {
            selected.add(optionId);
          }
        }
      }
      if (selected.size > 0) {
        selectedByQuestionId.set(questionId, selected);
      }
    }
  }

  const lines = [];
  if (title) {
    lines.push(`### ${title}`, '');
  }

  for (const question of questions) {
    if (!question || typeof question !== 'object') {
      continue;
    }
    const record = /** @type {Record<string, unknown>} */ (question);
    const questionId = typeof record.id === 'string' ? record.id : '';
    const prompt = typeof record.prompt === 'string' ? record.prompt.trim() : '';
    if (!prompt) {
      continue;
    }

    const allowMultiple = record.allowMultiple === true;
    const selected = questionId ? (selectedByQuestionId.get(questionId) ?? new Set()) : new Set();
    const suffix = allowMultiple ? ' *(select multiple)*' : '';
    lines.push(`**${prompt}**${suffix}`);

    const options = parseJsonArray(record.options);
    if (options) {
      for (const option of options) {
        if (!option || typeof option !== 'object') {
          continue;
        }
        const optionRecord = /** @type {Record<string, unknown>} */ (option);
        const optionId = typeof optionRecord.id === 'string' ? optionRecord.id : '';
        const label = typeof optionRecord.label === 'string' ? optionRecord.label.trim() : '';
        if (!label) {
          continue;
        }
        const checked = optionId && selected.has(optionId);
        lines.push(`- [${checked ? 'x' : ' '}] ${label}`);
      }
    }

    for (const entry of selected) {
      if (entry.startsWith('__freeform__:')) {
        lines.push(`- [x] ${entry.slice('__freeform__:'.length)}`);
      }
    }

    lines.push('');
  }

  return lines.join('\n').trim();
}

/**
 * @param {Record<string, unknown>} toolFormerData
 * @returns {string}
 */
function todoWriteToMarkdown(toolFormerData) {
  const result = parseJsonObject(toolFormerData.result);
  const finalTodos = result?.finalTodos ?? result?.todos;
  return todosToMarkdown(finalTodos, { heading: '### Tasks' });
}

/**
 * @param {unknown} actions
 * @returns {string}
 */
function suggestedActionsToMarkdown(actions) {
  const items = parseJsonArray(actions);
  if (!items || items.length === 0) {
    return '';
  }

  const lines = ['### Suggested actions', ''];
  for (const action of items) {
    if (!action || typeof action !== 'object') {
      continue;
    }
    const record = /** @type {Record<string, unknown>} */ (action);
    const label =
      (typeof record.label === 'string' && record.label.trim()) ||
      (typeof record.title === 'string' && record.title.trim()) ||
      (typeof record.text === 'string' && record.text.trim()) ||
      (typeof record.name === 'string' && record.name.trim());
    if (label) {
      lines.push(`- ${label}`);
    }
  }

  return lines.length > 2 ? lines.join('\n').trim() : '';
}

/**
 * @param {Record<string, unknown>} toolFormerData
 * @returns {string}
 */
function toolFormerToMarkdown(toolFormerData) {
  const toolName = typeof toolFormerData.name === 'string' ? toolFormerData.name.toLowerCase() : '';
  if (toolName === 'ask_question') {
    return askQuestionToMarkdown(toolFormerData);
  }
  if (toolName === 'todo_write') {
    return todoWriteToMarkdown(toolFormerData);
  }
  return '';
}

/**
 * Serialize one assistant bubble into markdown blocks shown in the agent tab.
 *
 * @param {Record<string, unknown>} bubble
 * @returns {string}
 */
export function bubbleToResponseMarkdown(bubble) {
  const parts = [];

  const text = typeof bubble.text === 'string' ? bubble.text.trim() : '';
  if (text) {
    parts.push(text);
  } else {
    const fromRichText = richTextToMarkdown(bubble.richText);
    if (fromRichText) {
      parts.push(fromRichText);
    }
  }

  const toolFormerData = parseJsonObject(bubble.toolFormerData);
  if (toolFormerData) {
    const toolMarkdown = toolFormerToMarkdown(toolFormerData);
    if (toolMarkdown) {
      parts.push(toolMarkdown);
    }
  }

  const bubbleTodos = todosToMarkdown(bubble.todos);
  if (bubbleTodos) {
    parts.push(bubbleTodos);
  }

  const suggestedActions = suggestedActionsToMarkdown(bubble.suggestedActions);
  if (suggestedActions) {
    parts.push(suggestedActions);
  }

  return parts.join('\n\n').trim();
}
