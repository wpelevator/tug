import os
SECRET_KEY = os.environ['APP_KEY']
DEBUG = False
ALLOWED_HOSTS = ['*']
ROOT_URLCONF = 'siteapp.urls'
INSTALLED_APPS = ['files']
DATABASES = {'default': {'ENGINE': 'django.db.backends.postgresql', 'NAME': 'app', 'USER': 'app', 'PASSWORD': os.environ['DB_PASSWORD'], 'HOST': 'db'}}
CACHES = {'default': {'BACKEND': 'django.core.cache.backends.redis.RedisCache', 'LOCATION': 'redis://redis:6379'}}
DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'
