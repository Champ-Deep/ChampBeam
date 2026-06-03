import axios from 'axios';
import api from './client';

// ============================================================
// Types
// ============================================================

export type FileKind = 'pdf' | 'video' | 'html' | 'image' | 'other';
export type FileStatus = 'pending_upload' | 'active' | 'failed' | 'deleted';
export type FileServeMode = 'stream' | 'redirect';

export interface FileAsset {
  id: string;
  short_code: string;
  filename: string;
  kind: FileKind;
  mime_type: string;
  size_bytes: number;
  status: FileStatus;
  serve_mode: FileServeMode;
  view_count: number;
  last_viewed_at: string | null;
  created_at: string;
  serve_url: string;
  domain_id: string | null;
}

export interface FileInitRequest {
  filename: string;
  content_type: string;
  size_bytes: number;
  domain_id?: string;
}

export interface FileInitResponse {
  file_id: string;
  short_code: string;
  presigned_put_url: string;
  headers: Record<string, string>;
  serve_mode: FileServeMode;
}

// ============================================================
// Helpers
// ============================================================

function _arr<T>(data: unknown): T[] {
  return Array.isArray(data) ? (data as T[]) : [];
}

// ============================================================
// API
// ============================================================

export const filesApi = {
  async list(): Promise<FileAsset[]> {
    const response = await api.get<FileAsset[]>('/files');
    return _arr<FileAsset>(response.data);
  },

  async initUpload(data: FileInitRequest): Promise<FileInitResponse> {
    const response = await api.post<FileInitResponse>('/files', data);
    return response.data;
  },

  /**
   * Upload bytes directly to the presigned URL.
   *
   * IMPORTANT: This uses a bare axios instance (not our `api` client) because
   * the presigned URL self-authenticates and we must NOT send the Clerk
   * Authorization header to Supabase Storage.
   */
  async uploadBytes(
    presignedUrl: string,
    file: File,
    headers: Record<string, string>,
    onProgress?: (pct: number) => void,
  ): Promise<void> {
    await axios.put(presignedUrl, file, {
      headers,
      onUploadProgress: (e) => {
        if (onProgress && e.total) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      },
    });
  },

  async finalize(fileId: string): Promise<FileAsset> {
    const response = await api.post<FileAsset>(`/files/${fileId}/finalize`);
    return response.data;
  },

  async delete(fileId: string): Promise<void> {
    await api.delete(`/files/${fileId}`);
  },
};

export default filesApi;
