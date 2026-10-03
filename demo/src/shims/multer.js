const fail = (_q, _s, next) => { const e = new Error('Импорт файлов доступен в полной версии на сервере'); e.status = 400; next(e); };
function multer() { return { single: () => fail }; }
multer.memoryStorage = () => null;
export default multer;
