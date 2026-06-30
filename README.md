# InstaDown – Instagram HD Video Endirici

Instagram videolarını HD keyfiyyətdə, logosuz və watermarksız endirin.

## Xüsusiyyətlər
- ✅ Post, Reel, IGTV dəstəyi  
- ✅ Orijinal HD keyfiyyət (keyfiyyət itkisi yoxdur)
- ✅ Logo / watermark / Instagram intro yoxdur
- ✅ Video birbaşa cihaz qalereyanıza enir
- ✅ PWA – Ana ekrana əlavə edilə bilir
- ✅ Real-time Socket.IO bağlantısı
- ✅ Mobil uyğun dizayn

## Deploy
- **Platform**: Render.com
- **Stack**: Node.js + Express + Socket.IO
- **Port**: `process.env.PORT`
- **Start**: `node server.js`

## İstifadə
1. Instagram post/reel/igtv linkini kopyalayın
2. Sayta daxil olun, linki yapışdırın
3. "Videonu Tap" düyməsinə basın
4. "HD Videonu Endir" düyməsinə basın → video qalereyanıza düşür

## Local Development
```bash
npm install
npm start
```

## API Endpoints
- `POST /api/extract` – Video URL-ini tap
- `GET /api/proxy?url=...` – Video stream proxisi
- `GET /api/health` – Server sağlamlıq yoxlaması
