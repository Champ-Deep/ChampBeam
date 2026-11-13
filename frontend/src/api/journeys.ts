import api from './client';

export interface JourneyTouch {
  at: string;
  asset: { type: 'link' | 'file'; id: string; title: string; url: string };
  city: string | null;
  country_code: string | null;
  lat: number | null;
  lon: number | null;
  device_type: string | null;
  count: number;
}

export interface VisitorJourney {
  visitor_id: string;
  first_at: string;
  last_at: string;
  touches: JourneyTouch[];
  cities: number;
  forwarded: boolean;
  company_name: string | null;
}

export interface JourneysResponse {
  journeys: VisitorJourney[];
  meta: { days: number; unattributed: number };
}

export const journeysApi = {
  async list(assetType?: 'link' | 'file', assetId?: string): Promise<JourneysResponse> {
    const params = assetType && assetId
      ? { asset_type: assetType, asset_id: assetId, days: 90, limit: 20 }
      : { days: 30, limit: 5 };
    const response = await api.get<JourneysResponse>(assetType ? '/analytics/journeys' : '/analytics/journeys/top', { params });
    return response.data;
  },
};
