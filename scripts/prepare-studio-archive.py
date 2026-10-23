#!/usr/bin/env python3
"""Fetch only pinned Studio source inputs; verify each blob and normalized tar."""
import concurrent.futures,hashlib,io,json,os,tarfile,tempfile,time,urllib.parse,urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]

def prepare():
    spec=json.loads((ROOT/'studio/upstream.json').read_text());manifest=json.loads((ROOT/'studio/source-files.json').read_text())
    if manifest['commit']!=spec['commit']:raise ValueError('Studio manifest commit mismatch')
    output=ROOT/'.cache/studio.tar';output.parent.mkdir(exist_ok=True)
    if output.exists():
        if hashlib.sha256(output.read_bytes()).hexdigest()!=spec['archiveSha256']:raise ValueError('Existing Studio archive changed')
        return
    def fetch(row):
        name,item=row
        if name.startswith('/') or '..' in Path(name).parts:raise ValueError('Unsafe source path')
        if item['mode']=='120000':
            if name!='rhwp-studio/public/fonts':raise ValueError('Unexpected source link')
            data=b'../../assets/fonts'
        else:
            url='https://raw.githubusercontent.com/edwardkim/rhwp/'+spec['commit']+'/'+urllib.parse.quote(name)
            for attempt in range(4):
                try:
                    with urllib.request.urlopen(url,timeout=60) as response:data=response.read(item['size']+1)
                    break
                except Exception:
                    if attempt==3:raise
                    time.sleep(attempt+1)
        if len(data)!=item['size'] or hashlib.sha256(data).hexdigest()!=item['sha256']:raise ValueError('Source integrity mismatch: '+name)
        blob=hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()
        if blob!=item['blobId']:raise ValueError('Git blob mismatch: '+name)
        return name,item,data
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:rows=list(pool.map(fetch,manifest['members'].items()))
    fd,temporary=tempfile.mkstemp(prefix='studio-',suffix='.tar',dir=output.parent);os.close(fd)
    try:
        with tarfile.open(temporary,'w',format=tarfile.GNU_FORMAT) as archive:
            for name,item,data in sorted(rows):
                entry=tarfile.TarInfo(name);entry.uid=entry.gid=entry.mtime=0;entry.uname=entry.gname=''
                if item['mode']=='120000':entry.type=tarfile.SYMTYPE;entry.linkname=data.decode();entry.mode=0o777
                else:
                    if item['mode'] not in ('100644','100755'):raise ValueError('Unsupported source mode')
                    entry.mode=0o755 if item['mode']=='100755' else 0o644;entry.size=len(data)
                archive.addfile(entry,io.BytesIO(data) if entry.isfile() else None)
        if hashlib.sha256(Path(temporary).read_bytes()).hexdigest()!=spec['archiveSha256']:raise ValueError('Studio archive integrity mismatch')
        if output.exists():raise ValueError('Studio archive appeared during preparation')
        os.rename(temporary,output)
    finally:
        if os.path.exists(temporary):os.unlink(temporary)
    print('Prepared pinned Studio archive:',spec['archiveSha256'])
if __name__=='__main__':prepare()
