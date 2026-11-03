<?php
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
Route::get('/health', fn () => response('ok'));
Route::get('/files', fn () => response(Cache::remember('files', 30, fn () => DB::table('files')->select('id', 'name')->orderBy('name')->get()->toJson()), 200, ['Content-Type' => 'application/json']));
Route::post('/files', function (Request $request) {
    $request->validate(['file' => 'required|file|max:5120']);
    $file = $request->file('file');
    $id = (string) Str::uuid();
    Storage::disk('s3')->put($id, fopen($file->getRealPath(), 'r'));
    try { DB::table('files')->insert(['id' => $id, 'name' => $file->getClientOriginalName(), 'object_key' => $id]); }
    catch (Throwable $e) { Storage::disk('s3')->delete($id); throw $e; }
    Cache::forget('files');
    return response()->json(['id' => $id, 'name' => $file->getClientOriginalName()], 201);
});
Route::get('/files/{id}', function (string $id) {
    $file = DB::table('files')->where('id', $id)->first();
    abort_unless($file, 404);
    return Storage::disk('s3')->response($file->object_key, null, ['Content-Type' => 'application/octet-stream']);
});
