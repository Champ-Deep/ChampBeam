#!/bin/bash
# Download MaxMind GeoLite2 databases (City + ASN)
#
# You need a free MaxMind account and license key:
# 1. Sign up at https://www.maxmind.com/en/geolite2/signup
# 2. Generate a license key at https://www.maxmind.com/en/accounts/current/license-key
# 3. Run: MAXMIND_KEY=your_key_here ./download_maxmind.sh

set -e

KEY="${MAXMIND_KEY:-$1}"
if [ -z "$KEY" ]; then
  echo "Usage: MAXMIND_KEY=your_key ./download_maxmind.sh"
  echo "   or: ./download_maxmind.sh your_key"
  exit 1
fi

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo "Downloading GeoLite2-City..."
curl -sS "https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-City&license_key=$KEY&suffix=tar.gz" -o city.tar.gz
tar xzf city.tar.gz
mv GeoLite2-City_*/GeoLite2-City.mmdb .
rm -rf GeoLite2-City_* city.tar.gz
echo "  -> GeoLite2-City.mmdb downloaded"

echo "Downloading GeoLite2-ASN..."
curl -sS "https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-ASN&license_key=$KEY&suffix=tar.gz" -o asn.tar.gz
tar xzf asn.tar.gz
mv GeoLite2-ASN_*/GeoLite2-ASN.mmdb .
rm -rf GeoLite2-ASN_* asn.tar.gz
echo "  -> GeoLite2-ASN.mmdb downloaded"

echo "Done! Both databases are ready in $DIR/"
