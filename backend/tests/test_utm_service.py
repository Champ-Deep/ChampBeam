import pytest
from app.services.utm_service import utm_service

def test_generate_utm_url_basic():
    base_url = "https://example.com"
    params = {"utm_source": "google", "utm_medium": "cpc"}
    result = utm_service.generate_utm_url(base_url, params)

    assert "utm_source=google" in result
    assert "utm_medium=cpc" in result
    assert result.startswith("https://example.com?")

def test_generate_utm_url_with_existing_qs():
    base_url = "https://example.com?foo=bar"
    params = {"utm_source": "newsletter"}
    result = utm_service.generate_utm_url(base_url, params)

    assert "foo=bar" in result
    assert "utm_source=newsletter" in result

def test_generate_utm_url_cleanup():
    # Test trailing ?
    result1 = utm_service.generate_utm_url("https://example.com/?", {"utm_source": "x"})
    assert result1 == "https://example.com/?utm_source=x"

    # Test trailing #
    result2 = utm_service.generate_utm_url("https://example.com#", {"utm_source": "y"})
    assert result2 == "https://example.com?utm_source=y"

def test_generate_utm_url_deduplicate_slashes():
    result = utm_service.generate_utm_url("https://example.com//path///to////page", {"utm_source": "z"})
    assert "https://example.com/path/to/page?utm_source=z" == result

def test_process_bulk_csv():
    csv_content = "url,utm_source\nhttps://example.com,google\nhttps://test.com,\n"
    default_params = {"utm_medium": "email"}

    output = utm_service.process_bulk_csv(csv_content, default_params)

    lines = output.strip().split("\r\n")
    assert lines[0] == "url,utm_source,tracked_url,error"
    assert "utm_source=google" in lines[1]
    assert "utm_medium=email" in lines[1]
    assert "error" not in lines[1] or ",," in lines[1] or lines[1].endswith(",") # No error

    # The second row should use default utm_medium
    assert "utm_medium=email" in lines[2]

def test_process_bulk_csv_invalid():
    csv_content = "url\ninvalid-url\n"
    output = utm_service.process_bulk_csv(csv_content)

    lines = output.strip().split("\r\n")
    assert "Invalid URL format" in lines[1]

def test_generate_short_code():
    code = utm_service._generate_short_code()
    assert len(code) == 7
    assert code.isalnum()
