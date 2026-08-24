-- FEATURE: Escala activa (self-service dto dinámico en 1ª compra)
-- Aplicar en el proyecto Supabase de Tierra Nativa (zjvpzqhbekxnwxdczpof)

-- 1. Columna nueva en customers
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS escala_activa boolean NOT NULL DEFAULT false;

-- 2. RPC para fijar el dto y apagar la escala atómicamente
CREATE OR REPLACE FUNCTION public.fijar_dto_escala(p_customer_id uuid, p_dto numeric)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Solo el propio cliente o un admin pueden fijar
  IF NOT EXISTS (
    SELECT 1 FROM customers c
    WHERE c.id = p_customer_id
      AND c.escala_activa = true
      AND (c.auth_user_id = auth.uid()
           OR EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()))
  ) THEN
    RAISE EXCEPTION 'no autorizado o escala no activa';
  END IF;

  UPDATE customers
    SET dto_vol = p_dto,
        escala_activa = false
  WHERE id = p_customer_id;
END;
$$;

-- Revocar acceso público (anon hereda de PUBLIC → sin esto cualquiera la llama)
REVOKE EXECUTE ON FUNCTION public.fijar_dto_escala(uuid, numeric) FROM public;
GRANT EXECUTE ON FUNCTION public.fijar_dto_escala(uuid, numeric) TO authenticated, service_role;

-- 3. Tabla de tramos (si no existe — verificar si el módulo Expo ya la creó)
-- Si ya existe expo_dto_escala, no hace falta crearla.
CREATE TABLE IF NOT EXISTS public.expo_dto_escala (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  desde numeric NOT NULL,  -- subtotal de lista desde el cual aplica
  dto   numeric NOT NULL,  -- fracción 0..1
  creado_at timestamptz DEFAULT now()
);
ALTER TABLE public.expo_dto_escala ENABLE ROW LEVEL SECURITY;

-- Policies (idempotente con IF NOT EXISTS via DO block)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'expo_escala_read' AND tablename = 'expo_dto_escala') THEN
    CREATE POLICY expo_escala_read ON public.expo_dto_escala FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'expo_escala_admin' AND tablename = 'expo_dto_escala') THEN
    CREATE POLICY expo_escala_admin ON public.expo_dto_escala FOR ALL
      USING (EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()))
      WITH CHECK (EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()));
  END IF;
END;
$$;

-- 4. Tramos de descuento por volumen para Tierra Nativa
-- Escala de descuento por volumen de Tierra Nativa (estirada, tope 25%).
-- OJO: esta tabla la comparten el módulo Expo y la escala activa. Este bloque
-- REEMPLAZA la escala completa. Los umbrales van sobre subtotal de LISTA 2.
DELETE FROM public.expo_dto_escala;
INSERT INTO public.expo_dto_escala (desde, dto) VALUES
  (0::numeric,       0::numeric),
  (1000000::numeric, 0.05::numeric),
  (2000000::numeric, 0.10::numeric),
  (3500000::numeric, 0.15::numeric),
  (5500000::numeric, 0.20::numeric),
  (8000000::numeric, 0.25::numeric);
