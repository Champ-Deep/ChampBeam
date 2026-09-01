import axios from 'axios';
import api from './client';
import type { ClickEvent, GeoBreakdownItem, DeviceBreakdown, DateRangeOpts } from './utm';
import { appendQuery as _appendQuery, asArray as _arr, dateParams as _dateParams } from './_shared';

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
  project_id?: string | null;
  expires_at?: string | null;
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
  // S3: a presigned PUT URL. Local backend: the relative API path of the blob
  // endpoint (with a signed token). The field name is kept for back-compat.
  presigned_put_url: string;
  headers: Record<string, string>;
  serve_mode: FileServeMode;
  // Anonymous (guest) uploads only, returned once.
  owner_token?: string | null;
  expires_at?: string | null;
  // True when the browser uploads to our own backend (local) rather than S3.
  upload_via_backend?: boolean;
}

export interface FileStatusResponse {
  view_count: number;
  last_viewed_at: string | null;
  expires_at: string | null;
  status: string;
  seen: boolean;
}

export interface FileSummary {
  file_id: string;
  filename: string;
  short_code: string;
  view_count: number;
  opens: number;
  unique_opens: number;
  last_viewed_at: string | null;
  created_at: string | null;
}

// Per-file analytics deliberately mirror the per-link analytics shapes, so we
// reuse the canonical types from the UTM API rather than redefining them.
export type FileEvent = ClickEvent;
export type FileGeoItem = GeoBreakdownItem;
export type FileDeviceBreakdown = DeviceBreakdown;

// ============================================================
// Helpers
// ============================================================

/** Resolve a backend-relative upload path against the API origin.
 *  api.defaults.baseURL already ends in /api/v1, so we take only its origin
 *  to avoid doubling the prefix (the blob path already includes /api/v1). */
function _resolveBackendUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  try {
    const origin = new URL(api.defaults.baseURL || window.location.origin).origin;
    return `${origin}${path}`;
  } catch {
    return path;
  }
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
   * Upload bytes to the target returned by initUpload.
   *
   * Always uses a bare axios instance (not our `api` client) so the Clerk
   * Authorization header is NEVER sent to the upload target, for S3 the
   * presigned URL self-authenticates; for the local backend the upload is
   * authorized by the signed token in the URL.
   */
  async uploadBytes(
    uploadUrl: string,
    file: File,
    headers: Record<string, string>,
    viaBackend?: boolean,
    onProgress?: (pct: number) => void,
  ): Promise<void> {
    const target = viaBackend ? _resolveBackendUrl(uploadUrl) : uploadUrl;
    await axios.put(target, file, {
      headers,
      onUploadProgress: (e) => {
        if (onProgress && e.total) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      },
    });
  },

  async finalize(fileId: string, ownerToken?: string | null): Promise<FileAsset> {
    const response = await api.post<FileAsset>(
      `/files/${fileId}/finalize`,
      ownerToken ? { owner_token: ownerToken } : {},
    );
    return response.data;
  },

  /** Poll a file's view status. Pass ownerToken for anonymous (guest) files. */
  async getStatus(fileId: string, ownerToken?: string | null): Promise<FileStatusResponse> {
    const response = await api.get<FileStatusResponse>(`/files/${fileId}/status`, {
      params: ownerToken ? { owner_token: ownerToken } : undefined,
    });
    return response.data;
  },

  async delete(fileId: string): Promise<void> {
    await api.delete(`/files/${fileId}`);
  },

  /** Assign a file to a project (project_id) or unfile it (project_id null). */
  async updateFile(fileId: string, data: { project_id: string | null }): Promise<FileAsset> {
    const response = await api.patch<FileAsset>(`/files/${fileId}`, data);
    return response.data;
  },

  // ============================================================
  // Per-file Analytics
  // ============================================================

  async getFileSummary(fileId: string): Promise<FileSummary> {
    const response = await api.get<FileSummary>(`/files/${fileId}/summary`);
    return response.data;
  },

  async getFileEvents(fileId: string, opts?: DateRangeOpts): Promise<FileEvent[]> {
    const params = _dateParams(opts);
    const response = await api.get<FileEvent[]>(
      _appendQuery(`/files/${fileId}/events`, params)
    );
    return _arr<FileEvent>(response.data);
  },

  async getFileGeo(fileId: string, opts?: DateRangeOpts & { level?: string }): Promise<FileGeoItem[]> {
    const params = _dateParams(opts);
    if (opts?.level) params.append('level', opts.level);
    const response = await api.get<FileGeoItem[]>(
      _appendQuery(`/files/${fileId}/geo`, params)
    );
    return _arr<FileGeoItem>(response.data);
  },

  async getFileDevices(fileId: string, opts?: DateRangeOpts): Promise<FileDeviceBreakdown> {
    const params = _dateParams(opts);
    const response = await api.get<FileDeviceBreakdown>(
      _appendQuery(`/files/${fileId}/devices`, params)
    );
    return response.data;
  },
};

export default filesApi;
