import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
});

// ---------------------------------------------------------------------------
// TypeScript Interfaces
// ---------------------------------------------------------------------------

export interface DesignConcept {
  id: number;
  book_id: number;
  concept_name: string;
  description: string;
  typography: string;
  imagery: string;
  texture: string;
  color_palette: string[];
  style: string;
  format: string;
  target_audience: string;
  is_favorite: boolean;
  copyright_flag: boolean;
  copyright_flag_reason: string;
  // Joined fields (from favorites endpoint)
  book_title?: string;
  book_author?: string;
  book_subgenre?: string;
}

export interface Book {
  id: number;
  run_id: number;
  rank: number;
  title: string;
  author: string;
  isbn: string;
  cover_url: string;
  synopsis: string;
  subgenre: string;
  character_archetypes: string[];
  visual_keywords: string[];
  color_palette: string[];
  tropes: string[];
  social_momentum: number;
  social_momentum_rationale: string;
  design_novelty: number;
  design_novelty_rationale: string;
  audience_size: number;
  audience_size_rationale: string;
  total_score: number;
  is_sleeper_pick: boolean;
  concepts: DesignConcept[];
}

export interface ReportSummary {
  run_id: number;
  run_date: string;
  status: string;
  books_processed: number;
  top_pick_title: string | null;
}

export interface ReportDetail {
  run_id: number;
  run_date: string;
  status: string;
  books_processed: number;
  books: Book[];
}

export interface RunStatus {
  run_id?: number;
  status: string;
  current_stage?: number;
  stage_label?: string;
  books_processed?: number;
  run_date?: string;
  error_log?: string;
  message?: string;
}

// ---------------------------------------------------------------------------
// API Functions
// ---------------------------------------------------------------------------

export async function triggerRun(): Promise<{ status: string; run_id: number }> {
  const { data } = await api.post('/run');
  return data;
}

export async function getStatus(): Promise<RunStatus> {
  const { data } = await api.get('/status');
  return data;
}

export async function getReports(): Promise<ReportSummary[]> {
  const { data } = await api.get('/reports');
  return data;
}

export async function getReportDetails(runId: number): Promise<ReportDetail> {
  const { data } = await api.get(`/reports/${runId}`);
  return data;
}

export async function getBook(bookId: number): Promise<Book> {
  const { data } = await api.get(`/books/${bookId}`);
  return data;
}

export async function toggleFavorite(conceptId: number, isFavorite: boolean): Promise<void> {
  await api.post(`/concepts/${conceptId}/favorite`, { is_favorite: isFavorite });
}

export async function getFavorites(filters?: {
  format?: string;
  style?: string;
  subgenre?: string;
}): Promise<DesignConcept[]> {
  const params: Record<string, string> = {};
  if (filters?.format) params.format = filters.format;
  if (filters?.style) params.style = filters.style;
  if (filters?.subgenre) params.subgenre = filters.subgenre;
  const { data } = await api.get('/favorites', { params });
  return data;
}
