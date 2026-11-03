import os
import uuid
import boto3
from django.core.cache import cache
from django.http import HttpResponse, JsonResponse, StreamingHttpResponse
from django.views.decorators.csrf import csrf_exempt
from .models import File

def s3():
    return boto3.client('s3', endpoint_url=os.environ['S3_ENDPOINT'], region_name=os.environ['S3_REGION'], aws_access_key_id=os.environ['S3_ACCESS_KEY'], aws_secret_access_key=os.environ['S3_SECRET_KEY'], config=boto3.session.Config(s3={'addressing_style': 'path'}))

def health(request):
    return HttpResponse('ok')

@csrf_exempt
def files(request):
    if request.method == 'GET':
        data = cache.get('files')
        if data is None:
            data = list(File.objects.order_by('name').values('id', 'name'))
            cache.set('files', data, 30)
        return JsonResponse(data, safe=False)
    if request.method != 'POST':
        return HttpResponse(status=405)
    upload = request.FILES.get('file')
    if not upload or upload.size > 5 * 1024 * 1024:
        return HttpResponse('file required (maximum 5 MiB)', status=400)
    key = str(uuid.uuid4())
    client = s3()
    client.upload_fileobj(upload, os.environ['S3_BUCKET'], key)
    try:
        row = File.objects.create(id=key, name=upload.name, object_key=key)
    except Exception:
        client.delete_object(Bucket=os.environ['S3_BUCKET'], Key=key)
        raise
    cache.delete('files')
    return JsonResponse({'id': str(row.id), 'name': row.name}, status=201)

def download(request, id):
    row = File.objects.filter(id=id).first()
    if row is None:
        return HttpResponse(status=404)
    body = s3().get_object(Bucket=os.environ['S3_BUCKET'], Key=row.object_key)['Body']
    return StreamingHttpResponse(body.iter_chunks(), content_type='application/octet-stream')
