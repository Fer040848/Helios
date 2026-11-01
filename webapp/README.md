# Helios Web Control 🟢

Controlador de shows láser para el **Helios Laser DAC** que se maneja **desde el celular**.
La app corre en la computadora (PC, Mac o Raspberry Pi) donde está conectado el DAC, y desde el
navegador de tu teléfono —en la misma red Wi‑Fi— disparas cues, cambias formas, colores y efectos,
escribes texto o dibujas con el dedo, mientras ves una vista previa en vivo de lo que proyecta el láser.

```
 📱 celular (navegador) ──Wi‑Fi──▶ 💻 PC con "python -m helios_web" ──USB──▶ Helios DAC ──ILDA──▶ 🔦 proyector
```

No necesitas instalar nada en el celular: es una página web. Puedes "Agregar a pantalla de inicio" para
usarla como app.

## Funciones

| Pestaña     | Qué hace                                                                                                                                                                                                   |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cues**    | Cuadrícula de 16 cues (presets), cada uno con una miniatura animada de su figura. Toca para disparar. Modo _Guardar_ para guardar la escena actual en un cue; mantén presionado un cue para renombrarlo o borrarlo. |
| **Forma**   | Círculo, cuadrado, triángulo, estrella, corazón, línea, espiral, onda, Lissajous, túnel, abanico, rejilla, flor, texto y dibujo. Tamaño, rotación, giro continuo, velocidad, posición con pad XY y espejo. |
| **Color**   | Colores rápidos, selector de color y modos: sólido, arcoíris, ciclo y al ritmo.                                                                                                                            |
| **Efecto**  | Pulso, ondulación, órbita, rebote, zoom, estrobo, vaivén y trazado. Intensidad, velocidad, BPM con botón **TAP** y sincronía al ritmo.                                                                     |
| **Texto**   | Escribe un texto (también Ñ y acentos) estático o en desplazamiento.                                                                                                                                       |
| **Dibujo**  | Dibuja con el dedo y se proyecta al instante.                                                                                                                                                              |
| **Ajustes** | Puntos por segundo (pps), brillo máximo, área de escaneo, invertir/intercambiar ejes, protección de haz y búsqueda de DACs.                                                                                |

Sin láser conectado arranca en **modo simulador**: todo funciona igual y ves la vista previa, ideal para probar.

## Versión web publicada (sin instalar nada): dac.ferchx.com

Abre **https://dac.ferchx.com** en **Chrome o Edge** y la página controla el DAC **directamente por USB** (WebUSB),
sin Python ni servidor:

- **Celular Android**: conecta el Helios al teléfono con un **cable USB OTG**, abre la página, ve a **Ajustes →
  Conectar DAC por USB** y elige el Helios. Como el Helios no tiene número de serie USB, Chrome no
  recuerda el permiso: si desconectas el DAC o reinicias el navegador, vuelve a tocar **Conectar DAC por USB**.
- **Computadora** (Windows, macOS, Linux, Chromebook): igual, con el Helios conectado por USB.
- **iPhone / Safari / Firefox** no tienen WebUSB: ahí la página funciona solo como demo con simulador. Para usar un
  iPhone como control remoto usa la app Python de abajo en una computadora con el DAC.
- Sin DAC conectado funciona en modo simulador. Los ajustes y cues se guardan en el navegador.
- La versión web solo maneja DACs **USB** (los DACs de red IDN necesitan la app Python).
- Por seguridad, si la app pasa a segundo plano (otra app, pantalla apagada) la salida se apaga sola; mientras emite,
  la pantalla se mantiene encendida.
- Linux: si Chrome no ve el DAC, configura las reglas udev de `docs/udev_rules_for_linux.md`.

## Instalación

Requisitos: **Python 3.9 o superior** en la computadora del DAC.

```bash
cd webapp
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

### Librería del DAC

La app usa la librería oficial del SDK de Helios (`sdk/cpp`). La busca en este orden: `--lib RUTA`,
la variable de entorno `HELIOS_LIB`, `webapp/lib/`, `sdk/cpp/shared_library/` y `sdk/examples/python/`.

- **Windows**: se usa `sdk/cpp/shared_library/HeliosLaserDAC.dll` (64 bits). Necesita `libusb-1.0.dll`
  de **64 bits** en la misma carpeta (descárgala de las versiones de libusb en libusb.info, carpeta `VS2015-x64`).
  Si Windows no reconoce el DAC, revisa la instalación del driver en `docs/getting_started.pdf`.
- **macOS**: se usa `sdk/cpp/shared_library/libHeliosLaserDAC.dylib`, o compílala con el script de abajo
  (`brew install libusb`).
- **Linux / Raspberry Pi**: compila la versión actual (con soporte de red IDN y 16 bits):

  ```bash
  sudo apt-get install g++ libusb-1.0-0-dev
  bash scripts/build_helios_lib.sh        # crea webapp/lib/libHeliosDacAPI.so
  ```

  Para usar el DAC sin `sudo`, configura las reglas udev de `docs/udev_rules_for_linux.md`.
  (Si no compilas, se usa la librería precompilada antigua de `sdk/examples/python/`, solo USB y 12 bits.)

## Uso

```bash
cd webapp
source .venv/bin/activate
python -m helios_web
```

La consola muestra la dirección para abrir en el celular, por ejemplo:

```
Abre en tu celular:  http://192.168.1.50:8080
```

1. Conecta el celular a la **misma red Wi‑Fi** que la computadora y abre esa dirección.
2. Elige un cue o arma tu escena. La vista previa muestra lo que se va a proyectar.
3. **Mantén presionado "MANTÉN PARA EMITIR"** para encender la salida del láser.
4. Toca el botón rojo **EN VIVO** para apagar (blackout) en cualquier momento. En la computadora, `Espacio` o `Esc`
   también apagan.

Opciones:

| Opción           | Descripción                                                          |
| ---------------- | -------------------------------------------------------------------- |
| `--port 8080`    | Puerto web                                                           |
| `--host 0.0.0.0` | Interfaz de red (por defecto todas)                                  |
| `--simulate`     | Fuerza el simulador aunque haya un DAC conectado                     |
| `--lib RUTA`     | Ruta a la librería del DAC                                           |
| `--data DIR`     | Carpeta donde se guardan ajustes y cues (por defecto `webapp/data/`) |

Si el celular no carga la página, revisa que el firewall de la computadora permita conexiones entrantes
al puerto 8080 de Python.

## ⚠️ Seguridad láser

Los láseres de show pueden causar daño ocular permanente. Esta app ayuda, pero **la responsabilidad es del operador**.

- La app **siempre arranca apagada**; encender requiere mantener presionado el botón.
- **Brillo máximo** (por defecto 30 %) limita la potencia de todo lo que se envía.
- **Área de escaneo** limita el tamaño máximo de la proyección: ajústala para que el láser nunca apunte al público.
- **Protección de haz** apaga el cuadro si el láser quedaría concentrado en un punto casi fijo.
- Si la app se cuelga, el DAC deja de emitir solo (cada cuadro se reproduce una sola vez).
- La app no tiene contraseña: úsala solo en una red Wi‑Fi de confianza, porque cualquiera en esa red podría controlarla.
- Ten siempre a mano el interruptor de emergencia físico del proyector y respeta las normas locales.

## Para desarrolladores

- Arquitectura y protocolo (HTTP + WebSocket): [`DESIGN.md`](DESIGN.md).
- Pruebas del backend: `cd webapp && python -m unittest discover -s tests -t . -v`
- Prueba de la interfaz con un backend simulado (Playwright para Node): `node tests/e2e/ui_mock.cjs`
- Versión web (WebUSB simulado en el navegador, miniaturas de cues y su costo por tick): `node tests/e2e/static_webusb.cjs`
- Motor JavaScript (paridad exacta con Python y seguridad WebUSB): `node --test tests/js/engine.test.mjs`
- Prueba de punta a punta con el servidor real: `PYTHON=.venv/bin/python node tests/e2e/integration.cjs`
