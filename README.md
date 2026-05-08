# CNCarve

Browser-based workflow: **setup wizard → Kiri:Moto CAM → G-code export → GRBL machine control** (Chrome or Edge on Windows and macOS).

## Run locally

```bash
cd web
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Production build

```bash
cd web
npm run build
npm start
```

## Notes

- **CAM** uses full-screen [Kiri:Moto](https://grid.space/kiri/); the setup wizard is an overlay. Click **Import into Kiri:Moto** after stock/pattern questions.
- Use **binary STL** files (ASCII STL is not supported yet).
- **USB carving** uses the Web Serial API — use **Chrome** or **Edge**, not Safari.
- Always stay at the machine when streaming G-code.
