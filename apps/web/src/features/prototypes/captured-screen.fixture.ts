/*
 * A captured e-Cidade-like screen as the capture delivers it: the original markup, classes and CSS
 * (layout tables, bevelled inputs…) with `data-ec` / `data-ec-part` annotations on the recognized
 * elements. All data is invented. Used by the tests of the component types and the palette.
 */

export const CAPTURED_HTML = `<body class="tela">
<table class="janela" width="100%" cellspacing="0"><tr><td class="titulo" data-ec="window-title"><span data-ec-part="title">Consultas &gt; Consulta Empenho</span></td></tr></table>
<form name="form1" method="post">
<fieldset class="moldura" data-ec="fieldset"><legend class="moldura-legenda" data-ec-part="legend">Consulta Empenho</legend>
<table class="layout" cellspacing="0" cellpadding="1" border="0">
<tr data-ec="lookup"><td class="rotulo" data-ec-part="label"><a class="lnk" href="#"><b>Número do Empenho:</b></a></td><td class="campo"><input class="in" data-ec-part="input" type="text" name="e60_numemp" value="" size="10" /><input class="in somente" data-ec-part="desc" type="text" name="descr" value="" size="40" readonly="readonly" /></td></tr>
<tr data-ec="lookup"><td class="rotulo" data-ec-part="label"><a class="lnk" href="#"><b>Credor:</b></a></td><td class="campo"><input class="in" data-ec-part="input" type="text" name="z01_numcgm" value="" size="10" /><input class="in somente" data-ec-part="desc" type="text" name="z01_nome" value="" size="40" readonly="readonly" /></td></tr>
<tr data-ec="field"><td class="rotulo" data-ec-part="label"><b>Número do Processo:</b></td><td class="campo"><input class="in" data-ec-part="input" type="text" name="proc" value="" size="20" /></td></tr>
<tr data-ec="date-range"><td class="rotulo" data-ec-part="label"><b>Período de Emissão:</b></td><td class="campo"><input class="in" data-ec-part="input" type="text" name="dt1" value="" size="10" /><input type="button" class="cal" data-ec-part="button" value="D" /> <span data-ec-part="separator">a</span> <input class="in" data-ec-part="input" type="text" name="dt2" value="" size="10" /><input type="button" class="cal" data-ec-part="button" value="D" /></td></tr>
<tr data-ec="select"><td class="rotulo" data-ec-part="label"><b>Situação:</b></td><td class="campo"><select class="in" data-ec-part="input" name="sit"><option value="0">Todas</option><option value="1">Ativas</option></select></td></tr>
</table>
</fieldset>
<div class="barra" data-ec="button-bar"><input type="button" class="btn" data-ec-part="button" value="Pesquisa" />&nbsp;<input type="button" class="btn" data-ec-part="button" value="Limpar campos" /></div>
<table class="grade" data-ec="grid" width="100%" cellspacing="1">
<thead><tr class="cab" data-ec-part="header"><th>Empenho</th><th>Credor</th><th>Valor</th></tr></thead>
<tbody>
<tr class="linha-par" data-ec-part="row"><td>101/2026</td><td>Fornecedor Alfa Ltda</td><td class="num">1.250,00</td></tr>
<tr class="linha-impar" data-ec-part="row"><td>102/2026</td><td>Comércio Beta ME</td><td class="num">890,50</td></tr>
</tbody>
</table>
<div class="rodape" data-ec="status-bar"><span>Instituição: Prefeitura de Exemplo</span> <span>Departamento: Finanças</span></div>
</form>
</body>`;

export const CAPTURED_CSS = `
@font-face{font-family:"ECFonte";src:url(data:font/woff2;base64,AAAA) format("woff2")}
@font-face{font-family:"Outra";src:url(data:font/woff2;base64,BBBB) format("woff2")}
:root{--azul:#1d4f9c;--cinza:#d4d0c8;--nao-usada:#ff0000}
body.tela{margin:0;background:#eeeeee;font:11px "ECFonte",Arial,sans-serif}
.janela{background:var(--azul);color:#ffffff}
.titulo{font-weight:bold;padding:3px 8px}
.moldura{border:1px solid #888888;padding:6px}
.moldura-legenda{color:#000066;font-weight:bold}
table.layout td.rotulo{width:140px;text-align:right}
table.layout td.campo{padding:1px 3px}
.lnk{color:#cc0000;text-decoration:underline}
.lnk:hover{color:#ff0000}
.in{border:1px solid #999999;background:#ffffff}
.in.somente{background:#deb887}
.cal{width:20px;background:var(--cinza)}
.barra{text-align:center;margin:8px 0}
.btn{background:var(--cinza);border:2px outset #ffffff}
.grade{border-collapse:separate}
.grade .cab th{background:#2c4a7c;color:#ffffff}
.linha-par td{background:#ffffff}
.linha-impar td{background:#e8eef7}
.num{text-align:right}
.rodape{background:#d4d0c8;border-top:1px solid #707070;padding:2px 8px}
.nunca-usada{color:red}
@media print{.barra{display:none}.nunca-usada{display:none}}
@keyframes pisca{from{opacity:0}to{opacity:1}}
`;
