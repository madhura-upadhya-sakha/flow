import { BadRequestException } from '@nestjs/common';

export function requiredText(value: unknown, label: string, maxLength: number) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    throw new BadRequestException(`Enter ${label} of up to ${maxLength} characters.`);
  }
  return value.trim();
}

export function optionalText(value: unknown, label: string, maxLength: number) {
  if (value === undefined || value === null || value === '') return null;
  return requiredText(value, label, maxLength);
}

export function dueDate(value: unknown, label = 'due date') {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string' && /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value) return value;
  }
  throw new BadRequestException(`Enter a valid ${label}.`);
}

export function rethrowTaskScheduleError(error: unknown): never {
  if (error instanceof Error && 'code' in error && error.code === '23514' &&
      'constraint' in error && error.constraint === 'ck_tasks_schedule_range') {
    throw new BadRequestException('The start date must be on or before the due date.');
  }
  throw error;
}

export function uuid(value: unknown) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) {
    throw new BadRequestException('Choose a valid project or team member.');
  }
  return value;
}

export function wholeMinutes(value: unknown, label: string, minimum = 1) {
  const minutes = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < minimum || minutes > 10080) {
    throw new BadRequestException(`Enter ${label} as whole minutes between ${minimum} and 10080.`);
  }
  return minutes;
}
