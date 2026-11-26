import type { SubscriptionFormat as SharedFormat } from '@iceslab/shared';
import { api } from '@/lib/net/client';

/**
 * Формат, который правило выдаёт клиенту.
 *
 * ⚠ Тот же союз, что у подписки, из контракта. Свой список здесь не знал
 * `xrayjson-array` и `amneziavpn`, хотя `/sub` их отдаёт: правило на них
 * завести было нельзя, и это выглядело как «панель не умеет», а не как
 * разошедшаяся копия.
 */
export type SubscriptionFormat = SharedFormat;

/** Какой файл WireGuard отдаёт правило с форматом `wgconf` (12.4). */
export type SrrProto = 'amneziawg' | 'wireguard';
export const SRR_PROTOS: readonly SrrProto[] = ['amneziawg', 'wireguard'];

export interface SrrRule {
  id: string;
  name: string;
  uaPattern: string;
  format: SubscriptionFormat;
  priority: number;
  enabled: boolean;
  /**
   * A-236 шаг 4 (BACK-2 51e2d152): шаблон, которым обрамляются клиенты
   * правила. `null` = Default. Поля нет (`undefined`) у сервера старше шага 4:
   * это «не знаю», и поле шаблона на экране тогда не рисуется.
   */
  templateName?: string | null;
  /**
   * 12.4: разновидность WireGuard; осмысленна только при формате `wgconf`.
   * `null` = правило её не называет. Поля нет (`undefined`) у сервера старше
   * 12.4: поле на экране тогда не рисуется.
   */
  proto?: SrrProto | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSrrInput {
  name: string;
  uaPattern: string;
  format: SubscriptionFormat;
  priority?: number;
  enabled?: boolean;
  templateName?: string | null;
  proto?: SrrProto | null;
}

export interface UpdateSrrInput {
  name?: string;
  uaPattern?: string;
  format?: SubscriptionFormat;
  priority?: number;
  enabled?: boolean;
  /** Нет ключа = не правка; `null` = вернуть Default. */
  templateName?: string | null;
  /** Нет ключа = не правка; `null` = без разновидности. */
  proto?: SrrProto | null;
}

/**
 * 400 с полем шаблона (srr.routes.ts, 51e2d152): формат шаблонов не берёт
 * (`SRR_TEMPLATE_NOT_FOR_FORMAT`) или шаблона с таким именем у типа нет
 * (`SRR_TEMPLATE_NOT_FOUND`). Вход проверяется первым; код читается только со
 * своим статусом.
 */
export interface SrrTemplateRefusal {
  code: 'SRR_TEMPLATE_NOT_FOR_FORMAT' | 'SRR_TEMPLATE_NOT_FOUND';
  message: string | null;
}

export function srrTemplateRefusal(err: unknown): SrrTemplateRefusal | null {
  if (!err || typeof err !== 'object') return null;
  const res = (err as { response?: unknown }).response;
  if (!res || typeof res !== 'object') return null;
  const { status, data } = res as { status?: unknown; data?: unknown };
  if (status !== 400 || !data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.error !== 'SRR_TEMPLATE_NOT_FOR_FORMAT' && d.error !== 'SRR_TEMPLATE_NOT_FOUND') return null;
  return { code: d.error, message: typeof d.message === 'string' ? d.message : null };
}

export async function listSrrRules(): Promise<{ rules: SrrRule[] }> {
  const { data } = await api.get<{ rules: SrrRule[] }>('/api/srr');
  return data;
}

export async function createSrrRule(input: CreateSrrInput): Promise<SrrRule> {
  const { data } = await api.post<SrrRule>('/api/srr', input);
  return data;
}

export async function updateSrrRule(id: string, input: UpdateSrrInput): Promise<SrrRule> {
  const { data } = await api.put<SrrRule>(`/api/srr/${id}`, input);
  return data;
}

export async function deleteSrrRule(id: string): Promise<void> {
  await api.delete(`/api/srr/${id}`);
}
