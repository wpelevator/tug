import uuid
from django.db import models
class File(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.TextField()
    object_key = models.TextField()
