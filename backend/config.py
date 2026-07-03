import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

class Config:
    DB_PATH        = os.path.join(BASE_DIR, "aqi.db")
    CACHE_TYPE     = "SimpleCache"
    CACHE_DEFAULT_TIMEOUT = 60       # seconds
    JSON_SORT_KEYS = False
    MAX_CONTENT_LENGTH = 16 * 1024 * 1024  # 16 MB upload limit

class DevelopmentConfig(Config):
    DEBUG = True
    CACHE_DEFAULT_TIMEOUT = 30

class ProductionConfig(Config):
    DEBUG = False
    CACHE_DEFAULT_TIMEOUT = 300

configs = {
    "development": DevelopmentConfig,
    "production":  ProductionConfig,
    "default":     DevelopmentConfig,
}
