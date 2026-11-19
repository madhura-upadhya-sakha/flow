import { BadRequestException } from '@nestjs/common';
import { dueDate, optionalText, requiredText } from './workspace-input';

const headers = ['title', 'description', 'status', 'priority', 'due_date', 'assignee_email'];
const statuses = ['To do', 'In progress', 'In review', 'Blocked', 'Done'];
const priorities = ['Low', 'Medium', 'High', 'Urgent'];

type Record = { line: number; values: string[] };
export type ImportRow =
  | { line: number; error: string }
  | {
    line: number; title: string; description: string | null; status: string;
    priority: string | null; due_date: string | null; assignee_id: string | null;
  };

export function importSource(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > 32768 || value.includes('\0')) {
    throw new BadRequestException('Upload a UTF-8 CSV file up to 32 KiB.');
  }
  return value;
}

function records(source: string): Record[] {
  const result: Record[] = [];
  let values: string[] = [];
  let field = '';
  let line = 1;
  let recordLine = 1;
  let mode: 'plain' | 'quoted' | 'closed' = 'plain';
  const text = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');

  function endRecord() {
    values.push(field);
    if (values.length > 1 || field.trim() || mode === 'closed') result.push({ line: recordLine, values });
    if (result.length > 101) throw new BadRequestException('Use at most 100 task rows per file.');
    field = '';
    values = [];
  }

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (mode === 'quoted') {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index++;
      } else if (char === '"') {
        mode = 'closed';
      } else {
        field += char;
        if (char === '\n') line++;
      }
    } else if (char === '\n') {
      endRecord();
      recordLine = ++line;
      mode = 'plain';
    } else if (char === ',') {
      values.push(field);
      field = '';
      mode = 'plain';
    } else if (char === '"' && mode === 'plain' && !field) {
      mode = 'quoted';
    } else if (mode === 'closed' || char === '"') {
      throw new BadRequestException(`Invalid CSV quoting on line ${line}.`);
    } else {
      field += char;
    }
  }
  if (mode === 'quoted') throw new BadRequestException(`Unclosed quoted field on line ${recordLine}.`);
  endRecord();
  return result;
}

export function validateImport(source: string, memberIds: Map<string, string>): ImportRow[] {
  const [header, ...rows] = records(source);
  if (!header || !rows.length) throw new BadRequestException('Include a header and at least one task row.');
  const columns = header.values.map((value) => value.trim().toLowerCase());
  if (!columns.includes('title') || new Set(columns).size !== columns.length || columns.some((name) => !headers.includes(name))) {
    throw new BadRequestException('Include a title header and use each supported column at most once.');
  }
  return rows.map(({ line, values }) => {
    if (values.length !== columns.length) return { line, error: 'Column count does not match the header.' };
    const value = (name: string) => values[columns.indexOf(name)]?.trim() ?? '';
    return validateImportRow(line, value, memberIds);
  });
}

export function validateImportRow(line: number, value: (name: string) => string, memberIds: Map<string, string>): ImportRow {
  try {
    const title = requiredText(value('title'), 'a task title', 240);
    const description = optionalText(value('description'), 'a description', 5000);
    const rawStatus = value('status').toLowerCase();
    const status = rawStatus === 'completed' ? 'Done' : statuses.find((entry) => entry.toLowerCase() === rawStatus);
    if (value('status') && !status) throw new BadRequestException('Use To do, In progress, In review, Blocked, or Completed.');
    const priority = priorities.find((entry) => entry.toLowerCase() === value('priority').toLowerCase());
    if (value('priority') && !priority) throw new BadRequestException('Use Low, Medium, High, or Urgent.');
    const email = value('assignee_email').toLowerCase();
    const assignee = memberIds.get(email);
    if (email && !assignee) throw new BadRequestException('Assignee email is not a workspace member.');
    return {
      line, title, description, status: status ?? 'To do',
      priority: priority ?? null, due_date: dueDate(value('due_date')), assignee_id: assignee ?? null,
    };
  } catch (failure) {
    if (!(failure instanceof BadRequestException)) throw failure;
    return { line, error: failure.message };
  }
}
