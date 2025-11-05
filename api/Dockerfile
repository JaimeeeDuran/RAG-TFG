FROM python:3.11-slim

# Crea el directorio de trabajo
WORKDIR /app

# Copia y instala dependencias
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copia el código de la API
COPY main.py .

# Expone el puerto (para FastAPI)
EXPOSE 8000

# Comando por defecto para ejecutar la app
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
