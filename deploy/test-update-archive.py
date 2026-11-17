import os, pathlib, sqlite3, subprocess, tarfile, tempfile, json
# Изолированные сценарии: системные команды подменены, SQLite-копия настоящая.
SCRIPT=pathlib.Path(__file__).with_name('update-archive.sh').read_text()
MOCK='''#!/usr/bin/env python3
import os,sys,pathlib,subprocess,shutil,sqlite3
name=pathlib.Path(sys.argv[0]).name;a=sys.argv[1:]; mode=os.environ['TEST_MODE'];root=pathlib.Path(os.environ['TEST_ROOT'])
if name=='id':
 if a==['-u']:print('0')
 sys.exit(0)
if name=='chown' or name=='sleep':sys.exit(0)
if name=='systemctl':
 with (root/'service.log').open('a') as f:f.write(' '.join(a)+'\\n')
 if a[0]=='show':print(os.environ['FF_UPDATE_APP'])
 sys.exit(0)
if name=='runuser':sys.exit(subprocess.call(a[a.index('--')+1:]))
if name=='npm':
 if mode=='build-fail':sys.exit(1)
 if 'build' in a:
  p=pathlib.Path('client/dist');p.mkdir(parents=True,exist_ok=True);(p/'index.html').write_text('new build')
 else:pathlib.Path('node_modules').mkdir(exist_ok=True)
 sys.exit(0)
if name=='curl':
 if '-o' in a:
  if mode=='download-fail':sys.exit(22)
  shutil.copyfile(root/'source.tgz',a[a.index('-o')+1]);sys.exit(0)
 sys.exit(22 if mode=='health-fail' else 0)
if name=='sqlite3':
 if mode=='backup-fail':sys.exit(1)
 db=sqlite3.connect(a[0])
 if a[1].startswith('.backup'):
  dest=sqlite3.connect(a[1].split("'",2)[1]);db.backup(dest);dest.close()
 else:print(db.execute('PRAGMA integrity_check').fetchone()[0])
 db.close();sys.exit(0)
raise RuntimeError(name)
'''
for mode in ['success','download-fail','build-fail','backup-fail','health-fail']:
 with tempfile.TemporaryDirectory() as d:
  r=pathlib.Path(d);app=r/'app';app.mkdir();b=r/'bin';b.mkdir();src=r/'release';src.mkdir()
  for part in ['server','client','deploy','tools','node_modules']:
   (app/part).mkdir();(app/part/'old-marker').write_text('old')
   if part!='node_modules':(src/part).mkdir();(src/part/'new-marker').write_text('new')
  for part in ['package.json','package-lock.json','README.md']:
   (app/part).write_text('old');(src/part).write_text('new')
  (app/'data').mkdir();dbpath=app/'data'/'fiberfleet.db';db=sqlite3.connect(dbpath);db.execute('CREATE TABLE entered_data(value)');db.execute("INSERT INTO entered_data VALUES ('keep me')");db.commit();db.close()
  (app/'.env').write_text('keep config');envfile=r/'service.env';envfile.write_text('FF_DATA_DIR='+str(app/'data')+'\nPORT=8082\n')
  with tarfile.open(r/'source.tgz','w:gz') as tar:tar.add(src,arcname='release')
  runner=b/'mock';runner.write_text(MOCK);runner.chmod(0o755)
  for name in ['id','chown','sleep','systemctl','runuser','npm','curl','sqlite3']:(b/name).symlink_to(runner)
  script=r/'update.sh';script.write_text(SCRIPT.replace('/run/lock/fiberfleet-update.lock',str(r/'update.lock')))
  env={**os.environ,'PATH':str(b)+':'+os.environ['PATH'],'FF_UPDATE_APP':str(app),'FF_UPDATE_ENV':str(envfile),'FF_UPDATE_BACKUPS':str(r/'backups'),'TEST_ROOT':str(r),'TEST_MODE':mode}
  out=subprocess.run(['bash',str(script)],env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
  assert (out.returncode==0)==(mode=='success'),(mode,out.stdout)
  assert (app/'.env').read_text()=='keep config'
  db=sqlite3.connect(dbpath);assert db.execute('SELECT value FROM entered_data').fetchone()[0]=='keep me';db.close()
  for part in ['server','client','deploy','tools']:
   assert (app/part/('new-marker' if mode=='success' else 'old-marker')).exists(),(mode,out.stdout)
  if mode in ['download-fail','build-fail']:assert not (r/'service.log').read_text().count('stop')
  if mode in ['success','health-fail']:
   backups=list((r/'backups').glob('*.db'));assert len(backups)==1
   db=sqlite3.connect(backups[0]);assert db.execute('SELECT value FROM entered_data').fetchone()[0]=='keep me';db.close()
  print('PASS',mode,'— data/config preserved; correct install/rollback and service handling')
