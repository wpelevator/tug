from django.urls import path
from files import views
urlpatterns = [path('health', views.health), path('files', views.files), path('files/<uuid:id>', views.download)]
